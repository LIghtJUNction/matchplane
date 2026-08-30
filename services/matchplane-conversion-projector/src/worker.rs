use std::{sync::Arc, time::Duration};

use matchplane_storage::{
    MarketplaceConversionBacklog, MarketplaceConversionClaimBatch,
    MarketplaceConversionFailureDisposition, MarketplaceConversionFailureOutcome,
    MarketplaceConversionJob, MarketplaceConversionProjectionOutcome, PgStore, StorageError,
};
use tokio::{sync::watch, time::Instant};
use tracing::{error, info, warn};

use crate::worker_metrics::WorkerMetrics;

const SERIAL_CLAIM_LIMIT: i64 = 1;

#[derive(Debug, Clone)]
pub(crate) struct WorkerSettings {
    pub(crate) poll_interval: Duration,
    #[cfg(test)]
    pub(crate) poll_observed: Option<Arc<tokio::sync::Notify>>,
}

pub(crate) trait ConversionStore: Send + Sync {
    async fn claim_batch(
        &self,
        limit: i64,
    ) -> Result<MarketplaceConversionClaimBatch, StorageError>;

    async fn project(
        &self,
        job: &MarketplaceConversionJob,
    ) -> Result<MarketplaceConversionProjectionOutcome, StorageError>;

    async fn fail(
        &self,
        job: &MarketplaceConversionJob,
        error: &str,
    ) -> Result<MarketplaceConversionFailureOutcome, StorageError>;

    async fn backlog(&self) -> Result<MarketplaceConversionBacklog, StorageError>;
}

impl ConversionStore for PgStore {
    async fn claim_batch(
        &self,
        limit: i64,
    ) -> Result<MarketplaceConversionClaimBatch, StorageError> {
        self.claim_marketplace_conversion_batch(limit).await
    }

    async fn project(
        &self,
        job: &MarketplaceConversionJob,
    ) -> Result<MarketplaceConversionProjectionOutcome, StorageError> {
        self.project_marketplace_conversion(job).await
    }

    async fn fail(
        &self,
        job: &MarketplaceConversionJob,
        error: &str,
    ) -> Result<MarketplaceConversionFailureOutcome, StorageError> {
        self.fail_marketplace_conversion(job, error).await
    }

    async fn backlog(&self) -> Result<MarketplaceConversionBacklog, StorageError> {
        self.marketplace_conversion_backlog().await
    }
}

pub(crate) async fn run_worker<S: ConversionStore>(
    store: &S,
    settings: WorkerSettings,
    metrics: Arc<WorkerMetrics>,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        if *shutdown.borrow() {
            return;
        }
        let claimed = store.claim_batch(SERIAL_CLAIM_LIMIT).await;
        match claimed {
            Ok(batch) => {
                let is_empty = batch.jobs.is_empty();
                handle_claim_batch(store, batch, &metrics).await;
                refresh_backlog(store, &metrics).await;
                if *shutdown.borrow() {
                    return;
                }
                if is_empty {
                    #[cfg(test)]
                    if let Some(poll_observed) = &settings.poll_observed {
                        poll_observed.notify_one();
                    }
                    if wait_for_poll(settings.poll_interval, &mut shutdown).await {
                        return;
                    }
                }
            }
            Err(error_value) => {
                metrics.loop_error();
                error!(
                    error_category = error_category(&error_value),
                    outcome = "claim_error",
                    "conversion projection claim loop failed"
                );
                if wait_for_poll(settings.poll_interval, &mut shutdown).await {
                    return;
                }
            }
        }
    }
}

async fn handle_claim_batch<S: ConversionStore>(
    store: &S,
    batch: MarketplaceConversionClaimBatch,
    metrics: &WorkerMetrics,
) {
    metrics.record_batch(batch.jobs.len(), batch.exhausted_dead);
    if batch.exhausted_dead != 0 {
        warn!(
            dead_count = batch.exhausted_dead,
            outcome = "attempts_exhausted_dead",
            "conversion projection claim watchdog dead-lettered exhausted jobs"
        );
    }
    for job in batch.jobs {
        // Once claim_batch commits a lease, shutdown must not strand it in publishing.
        process_job(store, &job, metrics).await;
    }
}

async fn process_job<S: ConversionStore>(
    store: &S,
    job: &MarketplaceConversionJob,
    metrics: &WorkerMetrics,
) {
    let started = Instant::now();
    metrics.begin_job();
    let projection = store.project(job).await;
    match projection {
        Ok(_) => {
            metrics.projected();
            info!(
                job_id = %job.id,
                tenant_id = %job.tenant_id,
                aggregate_id = %job.aggregate_id,
                source_category = source_category(&job.source_type),
                attempt = job.attempts,
                duration_ms = started.elapsed().as_millis() as u64,
                outcome = "projected",
                "conversion projection job completed"
            );
        }
        Err(StorageError::Conflict(_)) => {
            metrics.claim_conflict();
            warn!(
                job_id = %job.id,
                tenant_id = %job.tenant_id,
                aggregate_id = %job.aggregate_id,
                source_category = source_category(&job.source_type),
                attempt = job.attempts,
                duration_ms = started.elapsed().as_millis() as u64,
                outcome = "claim_lost",
                "conversion projection claim was lost"
            );
        }
        Err(error_value) => {
            let category = error_category(&error_value);
            let durable_error = error_value.to_string();
            match store.fail(job, &durable_error).await {
                Ok(failure) => match failure.disposition {
                    MarketplaceConversionFailureDisposition::Retry => {
                        metrics.retry();
                        warn!(
                            job_id = %job.id,
                            tenant_id = %job.tenant_id,
                            aggregate_id = %job.aggregate_id,
                            source_category = source_category(&job.source_type),
                            error_category = category,
                            attempt = job.attempts,
                            duration_ms = started.elapsed().as_millis() as u64,
                            outcome = "retry",
                            "conversion projection job scheduled for retry"
                        );
                    }
                    MarketplaceConversionFailureDisposition::Dead => {
                        metrics.dead();
                        error!(
                            job_id = %job.id,
                            tenant_id = %job.tenant_id,
                            aggregate_id = %job.aggregate_id,
                            source_category = source_category(&job.source_type),
                            error_category = category,
                            attempt = job.attempts,
                            duration_ms = started.elapsed().as_millis() as u64,
                            outcome = "dead",
                            "conversion projection job dead-lettered"
                        );
                    }
                },
                Err(StorageError::Conflict(_)) => {
                    metrics.claim_conflict();
                    warn!(
                        job_id = %job.id,
                        tenant_id = %job.tenant_id,
                        aggregate_id = %job.aggregate_id,
                        source_category = source_category(&job.source_type),
                        error_category = category,
                        attempt = job.attempts,
                        duration_ms = started.elapsed().as_millis() as u64,
                        outcome = "claim_lost",
                        "conversion projection failure transition lost its claim"
                    );
                }
                Err(transition_error) => {
                    metrics.loop_error();
                    error!(
                        job_id = %job.id,
                        tenant_id = %job.tenant_id,
                        aggregate_id = %job.aggregate_id,
                        source_category = source_category(&job.source_type),
                        error_category = category,
                        transition_error_category = error_category(&transition_error),
                        attempt = job.attempts,
                        duration_ms = started.elapsed().as_millis() as u64,
                        outcome = "transition_error",
                        "conversion projection failure transition failed"
                    );
                }
            }
        }
    }
    metrics.finish_job(started.elapsed().as_secs_f64());
}

async fn refresh_backlog<S: ConversionStore>(store: &S, metrics: &WorkerMetrics) {
    match store.backlog().await {
        Ok(backlog) => metrics.observe_backlog(backlog),
        Err(error_value) => {
            metrics.loop_error();
            error!(
                error_category = error_category(&error_value),
                outcome = "backlog_error",
                "conversion projection backlog refresh failed"
            );
        }
    }
}

async fn wait_for_poll(interval: Duration, shutdown: &mut watch::Receiver<bool>) -> bool {
    tokio::select! {
        () = tokio::time::sleep(interval) => *shutdown.borrow(),
        changed = shutdown.changed() => changed.is_err() || *shutdown.borrow(),
    }
}

fn source_category(source_type: &str) -> &'static str {
    match source_type {
        "introduction_contact_event" => "contact",
        "sales_handoff" => "handoff",
        _ => "unknown",
    }
}

fn error_category(error: &StorageError) -> &'static str {
    match error {
        StorageError::Sqlx(_) => "postgres",
        StorageError::Migration(_) => "migration",
        StorageError::IdempotencyConflict => "idempotency_conflict",
        StorageError::Forbidden(_) => "forbidden",
        StorageError::Conflict(_) => "conflict",
        StorageError::NotFound(_) => "not_found",
        StorageError::InvalidData(_) => "invalid_data",
        StorageError::InsufficientBalance => "insufficient_balance",
        StorageError::LeaseUnavailable => "lease_unavailable",
        StorageError::ReservationUnavailable => "reservation_unavailable",
        StorageError::StaleFencingToken => "stale_fencing_token",
        StorageError::ReplayDetected => "replay_detected",
        StorageError::ReservationVersionConflict => "reservation_version_conflict",
        StorageError::InvalidReservationTransition { .. } => "invalid_transition",
        StorageError::Wire(_) => "wire",
        StorageError::Engine(_) => "engine",
        StorageError::Json(_) => "json",
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        sync::{
            Mutex,
            atomic::{AtomicUsize, Ordering},
        },
    };

    use tokio::{
        sync::{Notify, watch},
        time::timeout,
    };
    use uuid::Uuid;

    use super::*;

    struct MockStore {
        project_results:
            Mutex<VecDeque<Result<MarketplaceConversionProjectionOutcome, StorageError>>>,
        fail_results: Mutex<VecDeque<Result<MarketplaceConversionFailureOutcome, StorageError>>>,
        unclaimed_jobs: Mutex<VecDeque<MarketplaceConversionJob>>,
        claimed_jobs: Mutex<Vec<Uuid>>,
        claim_limits: Mutex<Vec<i64>>,
        projected_jobs: AtomicUsize,
        shutdown_before_claim_return: Option<watch::Sender<bool>>,
    }

    impl MockStore {
        fn new(
            project_results: Vec<Result<MarketplaceConversionProjectionOutcome, StorageError>>,
            fail_results: Vec<Result<MarketplaceConversionFailureOutcome, StorageError>>,
        ) -> Self {
            Self {
                project_results: Mutex::new(project_results.into()),
                fail_results: Mutex::new(fail_results.into()),
                unclaimed_jobs: Mutex::new(VecDeque::new()),
                claimed_jobs: Mutex::new(Vec::new()),
                claim_limits: Mutex::new(Vec::new()),
                projected_jobs: AtomicUsize::new(0),
                shutdown_before_claim_return: None,
            }
        }

        fn with_unclaimed_jobs(self, jobs: Vec<MarketplaceConversionJob>) -> Self {
            self.unclaimed_jobs
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .extend(jobs);
            self
        }

        fn success() -> Self {
            Self::new(
                vec![Ok(MarketplaceConversionProjectionOutcome {
                    opportunity_id: Some(Uuid::now_v7()),
                    notifications_written: 1,
                })],
                Vec::new(),
            )
        }
    }

    impl ConversionStore for MockStore {
        async fn claim_batch(
            &self,
            limit: i64,
        ) -> Result<MarketplaceConversionClaimBatch, StorageError> {
            self.claim_limits
                .lock()
                .map_err(|_| {
                    StorageError::InvalidData("mock claim limits lock poisoned".to_owned())
                })?
                .push(limit);
            let mut unclaimed_jobs = self.unclaimed_jobs.lock().map_err(|_| {
                StorageError::InvalidData("mock unclaimed jobs lock poisoned".to_owned())
            })?;
            let mut jobs = Vec::new();
            for _ in 0..usize::try_from(limit.max(0)).unwrap_or(usize::MAX) {
                let Some(mut job) = unclaimed_jobs.pop_front() else {
                    break;
                };
                job.attempts += 1;
                jobs.push(job);
            }
            drop(unclaimed_jobs);
            self.claimed_jobs
                .lock()
                .map_err(|_| {
                    StorageError::InvalidData("mock claimed jobs lock poisoned".to_owned())
                })?
                .extend(jobs.iter().map(|job| job.id));
            if !jobs.is_empty()
                && let Some(sender) = &self.shutdown_before_claim_return
            {
                let _ = sender.send(true);
            }
            Ok(MarketplaceConversionClaimBatch {
                jobs,
                exhausted_dead: 0,
            })
        }

        async fn project(
            &self,
            _job: &MarketplaceConversionJob,
        ) -> Result<MarketplaceConversionProjectionOutcome, StorageError> {
            self.projected_jobs.fetch_add(1, Ordering::Relaxed);
            self.project_results
                .lock()
                .map_err(|_| StorageError::InvalidData("mock project lock poisoned".to_owned()))?
                .pop_front()
                .ok_or_else(|| {
                    StorageError::InvalidData("missing mock project result".to_owned())
                })?
        }

        async fn fail(
            &self,
            _job: &MarketplaceConversionJob,
            _error: &str,
        ) -> Result<MarketplaceConversionFailureOutcome, StorageError> {
            self.fail_results
                .lock()
                .map_err(|_| StorageError::InvalidData("mock failure lock poisoned".to_owned()))?
                .pop_front()
                .ok_or_else(|| {
                    StorageError::InvalidData("missing mock failure result".to_owned())
                })?
        }

        async fn backlog(&self) -> Result<MarketplaceConversionBacklog, StorageError> {
            Ok(MarketplaceConversionBacklog {
                pending: 0,
                publishing: 0,
                failed: 0,
                dead: 0,
                oldest_unresolved_seconds: None,
            })
        }
    }

    fn job() -> MarketplaceConversionJob {
        MarketplaceConversionJob {
            id: Uuid::now_v7(),
            tenant_id: Uuid::now_v7(),
            schema_version: 1,
            source_type: "sales_handoff".to_owned(),
            source_id: Uuid::now_v7(),
            aggregate_type: "marketplace_sales_handoff".to_owned(),
            aggregate_id: Uuid::now_v7(),
            aggregate_version: 1,
            event_type: "marketplace_sales_handoff_created".to_owned(),
            attempts: 1,
            claim_token: Uuid::now_v7(),
        }
    }

    async fn run_uninterrupted_batch(
        store: &MockStore,
        metrics: &WorkerMetrics,
        jobs: Vec<MarketplaceConversionJob>,
    ) {
        handle_claim_batch(
            store,
            MarketplaceConversionClaimBatch {
                jobs,
                exhausted_dead: 0,
            },
            metrics,
        )
        .await;
    }

    #[tokio::test]
    async fn successful_batch_should_record_claim_and_projection_metrics() {
        let store = MockStore::success();
        let metrics = WorkerMetrics::default();
        run_uninterrupted_batch(&store, &metrics, vec![job()]).await;

        let snapshot = metrics.snapshot();
        assert_eq!(snapshot.claimed, 1);
        assert_eq!(snapshot.projected, 1);
        assert_eq!(snapshot.retries, 0);
        assert_eq!(snapshot.inflight, 0);
        assert_eq!(snapshot.last_batch_size, 1);
        assert_eq!(snapshot.duration_observations, 1);
    }

    #[tokio::test]
    async fn failed_batch_should_record_retry_metrics() {
        let store = MockStore::new(
            vec![Err(StorageError::InvalidData(
                "deterministic failure".to_owned(),
            ))],
            vec![Ok(MarketplaceConversionFailureOutcome {
                disposition: MarketplaceConversionFailureDisposition::Retry,
                retry_delay_ms: Some(2_000),
            })],
        );
        let metrics = WorkerMetrics::default();
        run_uninterrupted_batch(&store, &metrics, vec![job()]).await;

        let snapshot = metrics.snapshot();
        assert_eq!(snapshot.claimed, 1);
        assert_eq!(snapshot.projected, 0);
        assert_eq!(snapshot.retries, 1);
        assert_eq!(snapshot.loop_errors, 0);
        assert_eq!(snapshot.inflight, 0);
    }

    #[tokio::test]
    async fn claim_conflict_should_not_schedule_failure_transition() {
        let store = MockStore::new(
            vec![Err(StorageError::Conflict("claim lost".to_owned()))],
            Vec::new(),
        );
        let metrics = WorkerMetrics::default();
        run_uninterrupted_batch(&store, &metrics, vec![job()]).await;

        let snapshot = metrics.snapshot();
        assert_eq!(snapshot.claim_conflicts, 1);
        assert_eq!(snapshot.retries, 0);
        assert_eq!(snapshot.dead, 0);
    }

    #[tokio::test]
    async fn shutdown_after_claim_commit_should_finish_the_claimed_job()
    -> Result<(), Box<dyn std::error::Error>> {
        let (shutdown_tx, shutdown) = watch::channel(false);
        let mut first = job();
        first.attempts = 0;
        let first_id = first.id;
        let mut unstarted = job();
        unstarted.attempts = 0;
        let unstarted_id = unstarted.id;
        let mut store = MockStore::new(
            vec![Ok(MarketplaceConversionProjectionOutcome {
                opportunity_id: Some(Uuid::now_v7()),
                notifications_written: 0,
            })],
            Vec::new(),
        );
        store.shutdown_before_claim_return = Some(shutdown_tx);
        let store = store.with_unclaimed_jobs(vec![first, unstarted]);
        let metrics = Arc::new(WorkerMetrics::default());

        timeout(
            Duration::from_secs(1),
            run_worker(
                &store,
                WorkerSettings {
                    poll_interval: Duration::from_secs(60),
                    poll_observed: None,
                },
                Arc::clone(&metrics),
                shutdown,
            ),
        )
        .await?;

        assert_eq!(
            store
                .claim_limits
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_slice(),
            [SERIAL_CLAIM_LIMIT]
        );
        assert_eq!(
            store
                .claimed_jobs
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_slice(),
            [first_id]
        );
        let remaining = store
            .unclaimed_jobs
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining.front().map(|job| job.id), Some(unstarted_id));
        assert_eq!(remaining.front().map(|job| job.attempts), Some(0));
        assert_eq!(store.projected_jobs.load(Ordering::Relaxed), 1);
        assert_eq!(metrics.snapshot().projected, 1);
        Ok(())
    }

    #[tokio::test]
    async fn shutdown_should_interrupt_an_empty_sixty_second_poll()
    -> Result<(), Box<dyn std::error::Error>> {
        let (shutdown_tx, shutdown) = watch::channel(false);
        let poll_observed = Arc::new(Notify::new());
        let store = Arc::new(MockStore::new(Vec::new(), Vec::new()));
        let worker_store = Arc::clone(&store);
        let worker_poll_observed = Arc::clone(&poll_observed);
        let worker = tokio::spawn(async move {
            run_worker(
                worker_store.as_ref(),
                WorkerSettings {
                    poll_interval: Duration::from_secs(60),
                    poll_observed: Some(worker_poll_observed),
                },
                Arc::new(WorkerMetrics::default()),
                shutdown,
            )
            .await;
        });

        poll_observed.notified().await;
        shutdown_tx.send(true)?;
        timeout(Duration::from_secs(1), worker).await??;

        assert_eq!(
            store
                .claim_limits
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_slice(),
            [SERIAL_CLAIM_LIMIT]
        );
        assert_eq!(store.projected_jobs.load(Ordering::Relaxed), 0);
        Ok(())
    }
}

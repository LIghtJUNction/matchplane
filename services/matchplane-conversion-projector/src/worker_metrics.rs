use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

use matchplane_storage::MarketplaceConversionBacklog;
use metrics::{counter, gauge, histogram};

#[derive(Debug, Default)]
pub(crate) struct WorkerMetrics {
    claimed: AtomicU64,
    projected: AtomicU64,
    retries: AtomicU64,
    dead: AtomicU64,
    claim_conflicts: AtomicU64,
    loop_errors: AtomicU64,
    inflight: AtomicU64,
    last_batch_size: AtomicU64,
    duration_observations: AtomicU64,
    backlog_pending: AtomicI64,
    backlog_publishing: AtomicI64,
    backlog_failed: AtomicI64,
    backlog_dead: AtomicI64,
    oldest_unresolved_seconds: AtomicI64,
}

impl WorkerMetrics {
    pub(crate) fn record_batch(&self, claimed: usize, exhausted_dead: u64) {
        let claimed = u64::try_from(claimed).unwrap_or(u64::MAX);
        self.claimed.fetch_add(claimed, Ordering::Relaxed);
        self.last_batch_size.store(claimed, Ordering::Relaxed);
        self.dead.fetch_add(exhausted_dead, Ordering::Relaxed);
        counter!("matchplane_conversion_projector_claimed_total").increment(claimed);
        counter!("matchplane_conversion_projector_dead_total").increment(exhausted_dead);
        histogram!("matchplane_conversion_projector_batch_size").record(claimed as f64);
    }

    pub(crate) fn begin_job(&self) {
        let inflight = self.inflight.fetch_add(1, Ordering::Relaxed) + 1;
        gauge!("matchplane_conversion_projector_inflight").set(inflight as f64);
    }

    pub(crate) fn finish_job(&self, duration_seconds: f64) {
        let previous = self.inflight.fetch_sub(1, Ordering::Relaxed);
        let inflight = previous.saturating_sub(1);
        self.duration_observations.fetch_add(1, Ordering::Relaxed);
        gauge!("matchplane_conversion_projector_inflight").set(inflight as f64);
        histogram!("matchplane_conversion_projector_duration_seconds").record(duration_seconds);
    }

    pub(crate) fn projected(&self) {
        self.projected.fetch_add(1, Ordering::Relaxed);
        counter!("matchplane_conversion_projector_projected_total").increment(1);
    }

    pub(crate) fn retry(&self) {
        self.retries.fetch_add(1, Ordering::Relaxed);
        counter!("matchplane_conversion_projector_retry_total").increment(1);
    }

    pub(crate) fn dead(&self) {
        self.dead.fetch_add(1, Ordering::Relaxed);
        counter!("matchplane_conversion_projector_dead_total").increment(1);
    }

    pub(crate) fn claim_conflict(&self) {
        self.claim_conflicts.fetch_add(1, Ordering::Relaxed);
        counter!("matchplane_conversion_projector_claim_conflict_total").increment(1);
    }

    pub(crate) fn loop_error(&self) {
        self.loop_errors.fetch_add(1, Ordering::Relaxed);
        counter!("matchplane_conversion_projector_loop_errors_total").increment(1);
    }

    pub(crate) fn observe_backlog(&self, backlog: MarketplaceConversionBacklog) {
        self.backlog_pending
            .store(backlog.pending, Ordering::Relaxed);
        self.backlog_publishing
            .store(backlog.publishing, Ordering::Relaxed);
        self.backlog_failed.store(backlog.failed, Ordering::Relaxed);
        self.backlog_dead.store(backlog.dead, Ordering::Relaxed);
        self.oldest_unresolved_seconds.store(
            backlog.oldest_unresolved_seconds.unwrap_or(-1),
            Ordering::Relaxed,
        );
        gauge!("matchplane_conversion_projector_backlog", "status" => "pending")
            .set(backlog.pending as f64);
        gauge!("matchplane_conversion_projector_backlog", "status" => "publishing")
            .set(backlog.publishing as f64);
        gauge!("matchplane_conversion_projector_backlog", "status" => "failed")
            .set(backlog.failed as f64);
        gauge!("matchplane_conversion_projector_backlog", "status" => "dead")
            .set(backlog.dead as f64);
        gauge!("matchplane_conversion_projector_oldest_unresolved_seconds")
            .set(backlog.oldest_unresolved_seconds.unwrap_or(0) as f64);
    }

    #[cfg(test)]
    pub(crate) fn snapshot(&self) -> WorkerMetricSnapshot {
        WorkerMetricSnapshot {
            claimed: self.claimed.load(Ordering::Relaxed),
            projected: self.projected.load(Ordering::Relaxed),
            retries: self.retries.load(Ordering::Relaxed),
            dead: self.dead.load(Ordering::Relaxed),
            claim_conflicts: self.claim_conflicts.load(Ordering::Relaxed),
            loop_errors: self.loop_errors.load(Ordering::Relaxed),
            inflight: self.inflight.load(Ordering::Relaxed),
            last_batch_size: self.last_batch_size.load(Ordering::Relaxed),
            duration_observations: self.duration_observations.load(Ordering::Relaxed),
        }
    }
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WorkerMetricSnapshot {
    pub(crate) claimed: u64,
    pub(crate) projected: u64,
    pub(crate) retries: u64,
    pub(crate) dead: u64,
    pub(crate) claim_conflicts: u64,
    pub(crate) loop_errors: u64,
    pub(crate) inflight: u64,
    pub(crate) last_batch_size: u64,
    pub(crate) duration_observations: u64,
}

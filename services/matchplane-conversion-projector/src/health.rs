use std::sync::Arc;

use axum::{
    Json, Router,
    extract::State,
    http::{StatusCode, header},
    response::IntoResponse,
    routing::get,
};
use matchplane_observability::Telemetry;
use matchplane_storage::{MarketplaceConversionBacklog, PgStore};
use serde::Serialize;

use crate::worker_metrics::WorkerMetrics;

#[derive(Clone)]
pub(crate) struct HealthState {
    pub(crate) store: PgStore,
    pub(crate) telemetry: Telemetry,
    pub(crate) metrics: Arc<WorkerMetrics>,
    pub(crate) enabled: bool,
    pub(crate) degraded_after_seconds: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Readiness {
    Ready,
    Degraded,
    Disabled,
    DatabaseUnavailable,
}

#[derive(Debug, Serialize)]
struct LiveBody {
    status: &'static str,
    service: &'static str,
}

#[derive(Debug, Serialize)]
struct HealthBody {
    status: &'static str,
    service: &'static str,
    database: &'static str,
    enabled: bool,
    degraded_after_seconds: u64,
    backlog: Option<BacklogBody>,
}

#[derive(Debug, Serialize)]
struct BacklogBody {
    pending: i64,
    publishing: i64,
    failed: i64,
    dead: i64,
    oldest_unresolved_seconds: Option<i64>,
}

impl From<MarketplaceConversionBacklog> for BacklogBody {
    fn from(backlog: MarketplaceConversionBacklog) -> Self {
        Self {
            pending: backlog.pending,
            publishing: backlog.publishing,
            failed: backlog.failed,
            dead: backlog.dead,
            oldest_unresolved_seconds: backlog.oldest_unresolved_seconds,
        }
    }
}

pub(crate) fn router(state: HealthState) -> Router {
    Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/metrics", get(metrics))
        .with_state(state)
}

async fn live() -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(LiveBody {
            status: "ok",
            service: "matchplane-conversion-projector",
        }),
    )
}

async fn ready(State(state): State<HealthState>) -> impl IntoResponse {
    if !state.enabled {
        return readiness_response(
            Readiness::Disabled,
            state.enabled,
            state.degraded_after_seconds,
            None,
        );
    }
    if state.store.ping().await.is_err() {
        return readiness_response(
            Readiness::DatabaseUnavailable,
            state.enabled,
            state.degraded_after_seconds,
            None,
        );
    }
    match state.store.marketplace_conversion_backlog().await {
        Ok(backlog) => {
            state.metrics.observe_backlog(backlog);
            let readiness =
                classify_readiness(true, true, Some(backlog), state.degraded_after_seconds);
            readiness_response(
                readiness,
                state.enabled,
                state.degraded_after_seconds,
                Some(backlog),
            )
        }
        Err(_) => readiness_response(
            Readiness::DatabaseUnavailable,
            state.enabled,
            state.degraded_after_seconds,
            None,
        ),
    }
}

fn readiness_response(
    readiness: Readiness,
    enabled: bool,
    degraded_after_seconds: u64,
    backlog: Option<MarketplaceConversionBacklog>,
) -> (StatusCode, Json<HealthBody>) {
    let (status_code, status, database) = match readiness {
        Readiness::Ready => (StatusCode::OK, "ready", "ok"),
        Readiness::Degraded => (StatusCode::OK, "degraded", "ok"),
        Readiness::Disabled => (StatusCode::SERVICE_UNAVAILABLE, "disabled", "unchecked"),
        Readiness::DatabaseUnavailable => {
            (StatusCode::SERVICE_UNAVAILABLE, "not_ready", "unavailable")
        }
    };
    (
        status_code,
        Json(HealthBody {
            status,
            service: "matchplane-conversion-projector",
            database,
            enabled,
            degraded_after_seconds,
            backlog: backlog.map(BacklogBody::from),
        }),
    )
}

fn classify_readiness(
    enabled: bool,
    database_ready: bool,
    backlog: Option<MarketplaceConversionBacklog>,
    degraded_after_seconds: u64,
) -> Readiness {
    if !enabled {
        return Readiness::Disabled;
    }
    if !database_ready {
        return Readiness::DatabaseUnavailable;
    }
    let Some(backlog) = backlog else {
        return Readiness::DatabaseUnavailable;
    };
    let age_degraded = backlog
        .oldest_unresolved_seconds
        .is_some_and(|age| age > i64::try_from(degraded_after_seconds).unwrap_or(i64::MAX));
    if backlog.dead > 0 || age_degraded {
        Readiness::Degraded
    } else {
        Readiness::Ready
    }
}

async fn metrics(State(state): State<HealthState>) -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        state.telemetry.render_metrics(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn backlog(dead: i64, oldest_unresolved_seconds: Option<i64>) -> MarketplaceConversionBacklog {
        MarketplaceConversionBacklog {
            pending: 1,
            publishing: 0,
            failed: 0,
            dead,
            oldest_unresolved_seconds,
        }
    }

    #[test]
    fn readiness_should_report_dead_backlog_as_degraded() {
        assert_eq!(
            classify_readiness(true, true, Some(backlog(1, Some(1))), 300),
            Readiness::Degraded
        );
    }

    #[test]
    fn readiness_should_report_old_backlog_as_degraded() {
        assert_eq!(
            classify_readiness(true, true, Some(backlog(0, Some(301))), 300),
            Readiness::Degraded
        );
        assert_eq!(
            classify_readiness(true, true, Some(backlog(0, Some(300))), 300),
            Readiness::Ready
        );
    }

    #[test]
    fn readiness_should_fail_closed_for_disabled_or_unavailable_worker() {
        assert_eq!(
            classify_readiness(false, true, Some(backlog(0, None)), 300),
            Readiness::Disabled
        );
        assert_eq!(
            classify_readiness(true, false, Some(backlog(0, None)), 300),
            Readiness::DatabaseUnavailable
        );
        assert_eq!(
            classify_readiness(true, true, None, 300),
            Readiness::DatabaseUnavailable
        );
    }
}

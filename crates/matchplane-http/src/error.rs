use std::fmt;

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;
use tracing::error;

/// Structured HTTP error returned by MatchPlane service adapters.
#[derive(Debug)]
pub struct ApiError {
    /// HTTP status code.
    pub status: StatusCode,
    /// Stable machine-readable error code.
    pub code: &'static str,
    /// Human-readable error message.
    pub message: String,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: &'static str,
    error: String,
}

impl ApiError {
    /// Creates an error with an explicit status, code, and message.
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    /// Returns a 400 invalid-request error.
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_request",
            message: message.into(),
        }
    }

    /// Returns a 401 unauthorized error.
    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "unauthorized",
            message: message.into(),
        }
    }

    /// Returns the default operator-bearer unauthorized response.
    pub fn operator_unauthorized() -> Self {
        Self::unauthorized("valid operator bearer authentication is required")
    }

    /// Returns the default marketplace-party unauthorized response.
    pub fn party_unauthorized() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "party_unauthorized",
            message: "valid marketplace party bearer authentication is required".to_owned(),
        }
    }

    /// Returns a 404 not-found error.
    pub fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: "not_found",
            message: message.into(),
        }
    }

    /// Returns a 403 forbidden error.
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: "forbidden",
            message: message.into(),
        }
    }

    /// Returns a 409 conflict error.
    pub fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code: "conflict",
            message: message.into(),
        }
    }

    /// Returns a 409 idempotency conflict error.
    pub fn idempotency_conflict() -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code: "idempotency_conflict",
            message: "idempotency key was already used with a different payload".to_owned(),
        }
    }

    /// Returns a 422 unprocessable entity error.
    pub fn unprocessable(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNPROCESSABLE_ENTITY,
            code: "unprocessable_entity",
            message: message.into(),
        }
    }

    /// Returns a 429 rate-limit error.
    pub fn too_many_requests(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            code: "rate_limited",
            message: message.into(),
        }
    }

    /// Returns a 500 internal error and logs the underlying detail.
    pub fn internal(detail: impl fmt::Display) -> Self {
        error!(detail = %detail, "HTTP request failed internally");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal_error",
            message: "internal service error".to_owned(),
        }
    }

    /// Returns a 500 internal error with an explicit client-visible message.
    pub fn internal_message(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            message,
        )
    }

    /// Returns a 503 dependency-unavailable error and logs the underlying detail.
    pub fn service_unavailable(detail: impl fmt::Display) -> Self {
        error!(detail = %detail, "HTTP dependency unavailable");
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "service_unavailable",
            message: "service temporarily unavailable".to_owned(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                code: self.code,
                error: self.message,
            }),
        )
            .into_response()
    }
}

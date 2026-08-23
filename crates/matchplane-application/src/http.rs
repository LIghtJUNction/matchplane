use axum::http::StatusCode;
use matchplane_http::ApiError;

use crate::ApplicationError;

impl From<ApiError> for ApplicationError {
    fn from(error: ApiError) -> Self {
        match error.status {
            StatusCode::UNAUTHORIZED => ApplicationError::unauthorized(error.message),
            StatusCode::FORBIDDEN => ApplicationError::forbidden(error.message),
            _ => ApplicationError::validation(error.message),
        }
    }
}

impl From<ApplicationError> for ApiError {
    fn from(error: ApplicationError) -> Self {
        match error {
            ApplicationError::Validation(message) => ApiError::bad_request(message),
            ApplicationError::Unauthorized(message) => ApiError::unauthorized(message),
            ApplicationError::Forbidden(message) => ApiError::forbidden(message),
            ApplicationError::Storage(storage) => ApiError::from(storage),
        }
    }
}

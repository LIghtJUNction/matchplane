use matchplane_storage::StorageError;

use crate::ApiError;

/// Converts domain-specific failures into the shared HTTP error envelope.
pub trait IntoApiError {
    /// Maps the error to an HTTP response.
    fn into_api_error(self) -> ApiError;
}

impl IntoApiError for StorageError {
    fn into_api_error(self) -> ApiError {
        storage_api_error(self)
    }
}

/// Maps a storage failure to the shared HTTP error envelope.
pub fn storage_api_error(error: StorageError) -> ApiError {
    match error {
        StorageError::IdempotencyConflict => ApiError::idempotency_conflict(),
        StorageError::NotFound(resource) => {
            ApiError::not_found(format!("{resource} was not found"))
        }
        StorageError::Forbidden(message) => ApiError::forbidden(message),
        StorageError::Conflict(message) => ApiError::conflict(message),
        StorageError::InsufficientBalance | StorageError::InvalidData(_) => {
            ApiError::unprocessable(error.to_string())
        }
        other => ApiError::internal(other),
    }
}

impl From<StorageError> for ApiError {
    fn from(error: StorageError) -> Self {
        storage_api_error(error)
    }
}

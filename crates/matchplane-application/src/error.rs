use matchplane_storage::StorageError;
use thiserror::Error;

/// Application-layer failures surfaced to service adapters.
#[derive(Debug, Error)]
pub enum ApplicationError {
    /// Input validation failed before persistence.
    #[error("{0}")]
    Validation(String),
    /// A downstream repository rejected the request.
    #[error(transparent)]
    Storage(#[from] StorageError),
}

impl ApplicationError {
    /// Returns a validation error for invalid caller input.
    pub fn validation(message: impl Into<String>) -> Self {
        Self::Validation(message.into())
    }
}

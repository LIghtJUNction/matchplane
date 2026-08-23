use matchplane_storage::StorageError;
use thiserror::Error;

/// Application-layer failures surfaced to service adapters.
#[derive(Debug, Error)]
pub enum ApplicationError {
    /// Input validation failed before persistence.
    #[error("{0}")]
    Validation(String),
    /// Caller authentication failed.
    #[error("{0}")]
    Unauthorized(String),
    /// Caller is authenticated but not allowed to perform the action.
    #[error("{0}")]
    Forbidden(String),
    /// A downstream repository rejected the request.
    #[error(transparent)]
    Storage(#[from] StorageError),
}

impl ApplicationError {
    /// Returns a validation error for invalid caller input.
    pub fn validation(message: impl Into<String>) -> Self {
        Self::Validation(message.into())
    }

    /// Returns an unauthorized error.
    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::Unauthorized(message.into())
    }

    /// Returns a forbidden error.
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::Forbidden(message.into())
    }
}

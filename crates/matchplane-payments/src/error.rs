use thiserror::Error;

/// Failures at the provider-neutral payment boundary.
#[derive(Debug, Error)]
pub enum PaymentError {
    /// Exact amount, currency, identifier, or configuration validation failed.
    #[error("invalid payment data: {0}")]
    Invalid(String),
    /// An idempotency key or stable payment ID was reused with changed content.
    #[error("payment idempotency conflict")]
    IdempotencyConflict,
    /// The selected gateway cannot perform the requested operation or payment method.
    #[error("gateway {gateway} does not support {operation}")]
    Unsupported {
        /// Stable gateway kind.
        gateway: &'static str,
        /// Requested operation.
        operation: &'static str,
    },
    /// The payment state machine rejected a transition.
    #[error("payment cannot transition from {from} to {to}")]
    InvalidTransition {
        /// Current normalized state.
        from: String,
        /// Requested target operation.
        to: &'static str,
    },
    /// A requested payment or refund does not exist.
    #[error("{0} was not found")]
    NotFound(&'static str),
    /// A production gateway credential reference could not be resolved.
    #[error("payment credential is unavailable: {0}")]
    Credential(String),
    /// A request or response signature was invalid.
    #[error("payment signature verification failed")]
    Signature,
    /// A provider returned a known rejection.
    #[error("payment provider rejected the request: {code}: {message}")]
    ProviderRejected {
        /// Stable provider code.
        code: String,
        /// Redacted provider explanation.
        message: String,
    },
    /// The provider outcome is unknown and must be reconciled through a status query.
    #[error("payment provider outcome is unknown; reconciliation is required")]
    UnknownOutcome,
    /// HTTP transport failed before a trusted terminal response was obtained.
    #[error("payment transport failed: {0}")]
    Transport(#[from] reqwest::Error),
    /// JSON conversion failed at a provider boundary.
    #[error("payment JSON conversion failed: {0}")]
    Json(#[from] serde_json::Error),
}

use async_trait::async_trait;

use crate::{
    AuthorizePayment, CapturePayment, GatewayDescriptor, GatewayStatus, PaymentError,
    PaymentOutcome, QueryPayment, RefundOutcome, RefundPayment, VoidPayment,
};

/// Standard provider interface used by all payment methods and gateway adapters.
#[async_trait]
pub trait PaymentGateway: std::fmt::Debug + Send + Sync {
    /// Returns non-secret adapter metadata and capabilities.
    fn descriptor(&self) -> &GatewayDescriptor;

    /// Reserves buyer funds or returns the buyer action needed to complete authorization.
    async fn authorize(&self, request: &AuthorizePayment) -> Result<PaymentOutcome, PaymentError>;

    /// Captures all or part of a prior authorization.
    async fn capture(&self, request: &CapturePayment) -> Result<PaymentOutcome, PaymentError>;

    /// Releases an unconsumed authorization.
    async fn void(&self, request: &VoidPayment) -> Result<PaymentOutcome, PaymentError>;

    /// Returns captured funds to the original payment method.
    async fn refund(&self, request: &RefundPayment) -> Result<RefundOutcome, PaymentError>;

    /// Reconciles an ambiguous or asynchronous provider outcome.
    async fn query(&self, request: &QueryPayment) -> Result<PaymentOutcome, PaymentError>;

    /// Checks provider reachability/configuration without performing a transaction.
    async fn health(&self) -> Result<GatewayStatus, PaymentError>;
}

//! Payment bounded-context contracts and provider adapters.
//!
//! Matching code depends only on the normalized state machine in this crate. Provider-specific
//! signatures, redirects, webhooks, and credentials stay behind [`PaymentGateway`]. Test mode is
//! explicit and production mode never falls back to a simulated gateway.

mod adapters;
mod error;
mod gateway;
mod invoice;
mod test_gateway;
mod types;

pub use adapters::{AlipayGateway, EpayGateway, WaffoGateway, WechatPayGateway};
pub use error::PaymentError;
pub use gateway::PaymentGateway;
pub use invoice::{
    HttpInvoiceProvider, InvoiceArtifact, InvoiceOutcome, InvoiceProvider, InvoiceRecipient,
    IssueInvoice, TestInvoiceProvider,
};
pub use test_gateway::TestGateway;
pub use types::{
    AuthorizePayment, CapturePayment, GatewayCapabilities, GatewayDescriptor, GatewayKind,
    GatewayMode, GatewayStatus, InvoiceKind, InvoiceStatus, Money, PaymentMethod, PaymentOutcome,
    PaymentStatus, PaymentToken, PaymentWebhook, QueryPayment, RefundOutcome, RefundPayment,
    RefundStatus, RefundWebhook, VoidPayment, WebhookEvent, WebhookRequest, calculate_commission,
    calculate_commission_reversal,
};

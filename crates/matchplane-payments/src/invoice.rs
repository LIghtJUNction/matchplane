use async_trait::async_trait;
use matchplane_domain::{InvoiceId, TenantId};
use serde::{Deserialize, Serialize};

use crate::{GatewayMode, GatewayStatus, InvoiceKind, InvoiceStatus, Money, PaymentError};

/// Sensitive invoice recipient details. Callers must encrypt this structure at rest.
#[derive(Clone, Serialize, Deserialize)]
pub struct InvoiceRecipient {
    /// Person or organization title printed on the invoice.
    pub title: String,
    /// Tax registration identifier, when applicable.
    pub tax_identifier: Option<String>,
    /// Delivery email for an electronic invoice.
    pub email: Option<String>,
    /// Registered address and telephone, when required.
    pub registered_address_phone: Option<String>,
    /// Bank name and account, when required.
    pub bank_account: Option<String>,
}

impl std::fmt::Debug for InvoiceRecipient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("InvoiceRecipient([REDACTED])")
    }
}

/// Normalized request sent to an invoice provider.
#[derive(Debug, Clone)]
pub struct IssueInvoice {
    /// Platform invoice ID.
    pub invoice_id: InvoiceId,
    /// Tenant boundary.
    pub tenant_id: TenantId,
    /// Vehicle sale or platform commission.
    pub kind: InvoiceKind,
    /// Exact invoice total.
    pub amount: Money,
    /// Decrypted recipient details, never persisted by an adapter.
    pub recipient: InvoiceRecipient,
    /// Human-readable line description.
    pub description: String,
}

/// Invoice or credit-note file produced by a provider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvoiceArtifact {
    /// MIME type, such as `application/pdf`.
    pub media_type: String,
    /// Provider bytes. The payment service encrypts these before persistence.
    pub content: Vec<u8>,
}

/// Normalized invoice-provider result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvoiceOutcome {
    /// Platform invoice ID.
    pub invoice_id: InvoiceId,
    /// Provider invoice reference.
    pub provider_reference: String,
    /// Issued invoice number.
    pub invoice_number: String,
    /// Normalized lifecycle state.
    pub status: InvoiceStatus,
    /// Optional downloadable artifact.
    pub artifact: Option<InvoiceArtifact>,
}

/// Standard invoice-provider extension point, independent of payment gateways.
#[async_trait]
pub trait InvoiceProvider: std::fmt::Debug + Send + Sync {
    /// Stable provider key used in routing and audit logs.
    fn provider_key(&self) -> &'static str;
    /// Explicit provider execution mode.
    fn mode(&self) -> GatewayMode;
    /// Issues a vehicle-sale or platform-commission invoice.
    async fn issue(&self, request: &IssueInvoice) -> Result<InvoiceOutcome, PaymentError>;
    /// Voids a request that has not entered an irreversible issued state.
    async fn void(&self, invoice_id: InvoiceId) -> Result<InvoiceStatus, PaymentError>;
    /// Issues a red-letter invoice/credit note after a refund.
    async fn red_letter(
        &self,
        request: &IssueInvoice,
        original_reference: &str,
    ) -> Result<InvoiceOutcome, PaymentError>;
    /// Checks provider availability without creating an invoice.
    async fn health(&self) -> Result<GatewayStatus, PaymentError>;
}

/// Deterministic invoice sandbox used by test mode.
#[derive(Debug, Default)]
pub struct TestInvoiceProvider;

#[async_trait]
impl InvoiceProvider for TestInvoiceProvider {
    fn provider_key(&self) -> &'static str {
        "local_test"
    }

    fn mode(&self) -> GatewayMode {
        GatewayMode::Test
    }

    async fn issue(&self, request: &IssueInvoice) -> Result<InvoiceOutcome, PaymentError> {
        let provider_reference = format!("test-invoice-{}", request.invoice_id);
        let invoice_number = format!(
            "TEST-{}",
            request
                .invoice_id
                .to_string()
                .replace('-', "")
                .to_uppercase()
        );
        let content = serde_json::to_vec(&serde_json::json!({
            "invoice_number": invoice_number,
            "kind": request.kind,
            "amount": request.amount,
            "description": request.description,
            "recipient": request.recipient,
            "test_mode": true
        }))?;
        Ok(InvoiceOutcome {
            invoice_id: request.invoice_id,
            provider_reference,
            invoice_number,
            status: InvoiceStatus::Issued,
            artifact: Some(InvoiceArtifact {
                media_type: "application/json".to_owned(),
                content,
            }),
        })
    }

    async fn void(&self, _invoice_id: InvoiceId) -> Result<InvoiceStatus, PaymentError> {
        Ok(InvoiceStatus::Voided)
    }

    async fn red_letter(
        &self,
        request: &IssueInvoice,
        original_reference: &str,
    ) -> Result<InvoiceOutcome, PaymentError> {
        let provider_reference = format!("test-credit-{}", request.invoice_id);
        let invoice_number = format!(
            "TEST-RED-{}",
            request
                .invoice_id
                .to_string()
                .replace('-', "")
                .to_uppercase()
        );
        let content = serde_json::to_vec(&serde_json::json!({
            "credit_note_number": invoice_number,
            "original_reference": original_reference,
            "kind": request.kind,
            "amount": request.amount,
            "description": request.description,
            "recipient": request.recipient,
            "test_mode": true
        }))?;
        Ok(InvoiceOutcome {
            invoice_id: request.invoice_id,
            provider_reference,
            invoice_number,
            status: InvoiceStatus::RedLettered,
            artifact: Some(InvoiceArtifact {
                media_type: "application/json".to_owned(),
                content,
            }),
        })
    }

    async fn health(&self) -> Result<GatewayStatus, PaymentError> {
        Ok(GatewayStatus {
            healthy: true,
            message: "deterministic invoice sandbox ready".to_owned(),
        })
    }
}

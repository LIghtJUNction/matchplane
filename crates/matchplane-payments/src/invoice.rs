use std::{fmt, time::Duration};

use async_trait::async_trait;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use matchplane_domain::{InvoiceId, TenantId};
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use url::Url;

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
    fn provider_key(&self) -> &str;
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
    fn provider_key(&self) -> &str {
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

/// Production invoice adapter for a tax provider implementing MatchPlane's signed JSON contract.
///
/// The provider endpoint is intentionally configurable because mainland tax-invoice vendors use
/// different commercial onboarding and regional endpoints. The adapter does not silently turn a
/// provider response into a local invoice: it requires an authenticated HTTPS response containing
/// a provider reference, invoice number, and (for electronic invoices) a bounded artifact.
pub struct HttpInvoiceProvider {
    key: String,
    base_url: Url,
    issue_path: String,
    void_path: String,
    red_letter_path: String,
    client: reqwest::Client,
    bearer_token: SecretString,
}

impl fmt::Debug for HttpInvoiceProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HttpInvoiceProvider")
            .field("key", &self.key)
            .field("base_url", &self.base_url)
            .field("issue_path", &self.issue_path)
            .field("void_path", &self.void_path)
            .field("red_letter_path", &self.red_letter_path)
            .field("bearer_token", &"[REDACTED]")
            .finish()
    }
}

impl HttpInvoiceProvider {
    /// Creates a production adapter from a provider configuration object and secret token.
    pub fn new(
        key: impl Into<String>,
        settings: &Value,
        bearer_token: SecretString,
    ) -> Result<Self, PaymentError> {
        let base_url = settings
            .get("base_url")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                PaymentError::Invalid("invoice provider base_url is required".to_owned())
            })?;
        let (base_url, client) = crate::provider_http_client(
            base_url,
            "invoice provider base_url",
            Duration::from_secs(20),
        )?;
        let path = |name: &str, default: &str| -> Result<String, PaymentError> {
            let value = settings
                .get(name)
                .and_then(Value::as_str)
                .unwrap_or(default);
            if !value.starts_with('/')
                || value.contains("//")
                || value.contains("..")
                || value.contains('?')
                || value.contains('#')
            {
                return Err(PaymentError::Invalid(format!(
                    "invoice provider {name} must be an absolute path without a query"
                )));
            }
            Ok(value.to_owned())
        };
        if bearer_token.expose_secret().trim().is_empty() {
            return Err(PaymentError::Credential(
                "invoice provider bearer token is empty".to_owned(),
            ));
        }
        Ok(Self {
            key: key.into(),
            base_url,
            issue_path: path("issue_path", "/v1/invoices")?,
            void_path: path("void_path", "/v1/invoices/{invoice_id}/void")?,
            red_letter_path: path("red_letter_path", "/v1/invoices/red-letter")?,
            client,
            bearer_token,
        })
    }

    async fn post(&self, path: &str, body: Value) -> Result<Value, PaymentError> {
        let url = self
            .base_url
            .join(path.trim_start_matches('/'))
            .map_err(|error| {
                PaymentError::Invalid(format!("invoice provider URL is invalid: {error}"))
            })?;
        let response = self
            .client
            .post(url)
            .bearer_auth(self.bearer_token.expose_secret())
            .header(reqwest::header::ACCEPT, "application/json")
            .json(&body)
            .send()
            .await?;
        let status = response.status();
        let bytes = response.bytes().await?;
        let value: Value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)?
        };
        if !status.is_success() {
            return Err(PaymentError::ProviderRejected {
                code: value
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("http_error")
                    .to_owned(),
                message: value
                    .get("message")
                    .or_else(|| value.get("msg"))
                    .and_then(Value::as_str)
                    .unwrap_or("invoice provider rejected the request")
                    .to_owned(),
            });
        }
        Ok(value)
    }

    fn outcome(
        &self,
        request: &IssueInvoice,
        value: &Value,
        status: InvoiceStatus,
    ) -> Result<InvoiceOutcome, PaymentError> {
        let provider_reference = value
            .get("provider_reference")
            .or_else(|| value.get("reference"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                PaymentError::Invalid("invoice provider omitted provider_reference".to_owned())
            })?
            .to_owned();
        let invoice_number = value
            .get("invoice_number")
            .or_else(|| value.get("invoiceNumber"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                PaymentError::Invalid("invoice provider omitted invoice_number".to_owned())
            })?
            .to_owned();
        let artifact = match value.get("artifact") {
            None | Some(Value::Null) => None,
            Some(artifact) => {
                let media_type = artifact
                    .get("media_type")
                    .or_else(|| artifact.get("mediaType"))
                    .and_then(Value::as_str)
                    .unwrap_or("application/pdf")
                    .to_owned();
                let encoded = artifact
                    .get("content_base64")
                    .or_else(|| artifact.get("contentBase64"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        PaymentError::Invalid("invoice artifact content is missing".to_owned())
                    })?;
                let content = STANDARD.decode(encoded).map_err(|_| {
                    PaymentError::Invalid("invoice artifact is not valid base64".to_owned())
                })?;
                if content.is_empty() || content.len() > 10 * 1024 * 1024 {
                    return Err(PaymentError::Invalid(
                        "invoice artifact must contain 1..=10 MiB".to_owned(),
                    ));
                }
                Some(InvoiceArtifact {
                    media_type,
                    content,
                })
            }
        };
        Ok(InvoiceOutcome {
            invoice_id: request.invoice_id,
            provider_reference,
            invoice_number,
            status,
            artifact,
        })
    }

    fn request_json(request: &IssueInvoice) -> Value {
        json!({
            "invoice_id": request.invoice_id,
            "tenant_id": request.tenant_id,
            "kind": request.kind,
            "amount": request.amount,
            "recipient": request.recipient,
            "description": request.description,
        })
    }
}

#[async_trait]
impl InvoiceProvider for HttpInvoiceProvider {
    fn provider_key(&self) -> &str {
        &self.key
    }

    fn mode(&self) -> GatewayMode {
        GatewayMode::Production
    }

    async fn issue(&self, request: &IssueInvoice) -> Result<InvoiceOutcome, PaymentError> {
        let value = self
            .post(&self.issue_path, Self::request_json(request))
            .await?;
        self.outcome(request, &value, InvoiceStatus::Issued)
    }

    async fn void(&self, invoice_id: InvoiceId) -> Result<InvoiceStatus, PaymentError> {
        let path = self
            .void_path
            .replace("{invoice_id}", &invoice_id.to_string());
        self.post(&path, json!({"invoice_id": invoice_id})).await?;
        Ok(InvoiceStatus::Voided)
    }

    async fn red_letter(
        &self,
        request: &IssueInvoice,
        original_reference: &str,
    ) -> Result<InvoiceOutcome, PaymentError> {
        let mut body = Self::request_json(request);
        body["original_reference"] = Value::String(original_reference.to_owned());
        let value = self.post(&self.red_letter_path, body).await?;
        self.outcome(request, &value, InvoiceStatus::RedLettered)
    }

    async fn health(&self) -> Result<GatewayStatus, PaymentError> {
        let response = self
            .client
            .get(self.base_url.clone())
            .bearer_auth(self.bearer_token.expose_secret())
            .timeout(Duration::from_secs(5))
            .send()
            .await?;
        if response.status().is_success() {
            Ok(GatewayStatus {
                healthy: true,
                message: "invoice provider HTTPS endpoint reachable".to_owned(),
            })
        } else {
            Err(PaymentError::ProviderRejected {
                code: response.status().as_u16().to_string(),
                message: "invoice provider health check failed".to_owned(),
            })
        }
    }
}

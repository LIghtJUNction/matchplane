use std::{fmt, str::FromStr};

use matchplane_domain::{PaymentGatewayId, PaymentId, RefundId, TenantId};
use secrecy::SecretString;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::PaymentError;

/// Administrator-selected payment execution mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GatewayMode {
    /// Deterministic local sandbox; never contacts a provider.
    Test,
    /// Real provider execution; credentials and HTTPS are mandatory.
    Production,
}

impl GatewayMode {
    /// Stable database/configuration code.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Test => "test",
            Self::Production => "production",
        }
    }
}

impl FromStr for GatewayMode {
    type Err = PaymentError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "test" => Ok(Self::Test),
            "production" => Ok(Self::Production),
            _ => Err(PaymentError::Invalid(format!(
                "unknown gateway mode {value}"
            ))),
        }
    }
}

/// Built-in gateway adapter kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GatewayKind {
    /// Local deterministic sandbox.
    Test,
    /// EPay-compatible redirect protocol.
    Epay,
    /// Waffo Pancake acquiring API.
    WaffoPancake,
    /// WeChat Pay API v3.
    WechatPayV3,
    /// Alipay OpenAPI using RSA2.
    AlipayOpenapi,
    /// Administrator-supplied adapter implementation.
    Custom,
}

impl GatewayKind {
    /// Stable configuration code.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Test => "test",
            Self::Epay => "epay",
            Self::WaffoPancake => "waffo_pancake",
            Self::WechatPayV3 => "wechat_pay_v3",
            Self::AlipayOpenapi => "alipay_openapi",
            Self::Custom => "custom",
        }
    }
}

impl FromStr for GatewayKind {
    type Err = PaymentError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "test" => Ok(Self::Test),
            "epay" => Ok(Self::Epay),
            "waffo_pancake" => Ok(Self::WaffoPancake),
            "wechat_pay_v3" => Ok(Self::WechatPayV3),
            "alipay_openapi" => Ok(Self::AlipayOpenapi),
            "custom" => Ok(Self::Custom),
            _ => Err(PaymentError::Invalid(format!(
                "unknown gateway kind {value}"
            ))),
        }
    }
}

/// Exact money in the currency's smallest configured unit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Money {
    /// Signed base-10 integer serialized as text to prevent JSON precision loss.
    pub amount: String,
    /// ISO-4217-style uppercase currency code.
    pub currency: String,
    /// Decimal scale used when rendering provider amounts.
    pub scale: u8,
}

impl Money {
    /// Constructs a validated non-negative money amount.
    ///
    /// # Errors
    ///
    /// Returns [`PaymentError::Invalid`] for negative values, malformed currencies, or scales
    /// above 18.
    pub fn new(amount: i128, currency: impl Into<String>, scale: u8) -> Result<Self, PaymentError> {
        let currency = currency.into();
        if amount < 0 {
            return Err(PaymentError::Invalid(
                "money amount cannot be negative".to_owned(),
            ));
        }
        if scale > 18 {
            return Err(PaymentError::Invalid(
                "money scale must be in 0..=18".to_owned(),
            ));
        }
        if currency.len() != 3
            || !currency
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() && byte.is_ascii_alphabetic())
        {
            return Err(PaymentError::Invalid(
                "currency must contain three uppercase ASCII letters".to_owned(),
            ));
        }
        Ok(Self {
            amount: amount.to_string(),
            currency,
            scale,
        })
    }

    /// Returns the exact integer value.
    ///
    /// # Errors
    ///
    /// Returns [`PaymentError::Invalid`] if deserialized input exceeds `i128`.
    pub fn exact_amount(&self) -> Result<i128, PaymentError> {
        self.amount.parse().map_err(|_| {
            PaymentError::Invalid("money amount is not an exact base-10 integer".to_owned())
        })
    }

    /// Formats the exact value using the configured currency scale.
    ///
    /// # Errors
    ///
    /// Returns [`PaymentError::Invalid`] for malformed deserialized input.
    pub fn decimal_string(&self) -> Result<String, PaymentError> {
        let amount = self.exact_amount()?;
        if self.scale == 0 {
            return Ok(amount.to_string());
        }
        let divisor = 10_i128
            .checked_pow(u32::from(self.scale))
            .ok_or_else(|| PaymentError::Invalid("money scale overflow".to_owned()))?;
        Ok(format!(
            "{}.{:0width$}",
            amount / divisor,
            amount % divisor,
            width = usize::from(self.scale)
        ))
    }
}

/// Calculates a nearest-minor-unit marketplace commission from basis points.
///
/// # Errors
///
/// Returns [`PaymentError::Invalid`] when the rate exceeds 100%, the amount is negative, or
/// intermediate exact arithmetic overflows.
pub fn calculate_commission(gross: i128, basis_points: u16) -> Result<i128, PaymentError> {
    if gross < 0 || basis_points > 10_000 {
        return Err(PaymentError::Invalid(
            "commission requires non-negative gross and at most 10,000 bps".to_owned(),
        ));
    }
    gross
        .checked_mul(i128::from(basis_points))
        .and_then(|value| value.checked_add(5_000))
        .map(|value| value / 10_000)
        .ok_or_else(|| PaymentError::Invalid("commission arithmetic overflow".to_owned()))
}

/// Calculates the incremental commission reversal for a full or partial refund.
///
/// The calculation uses cumulative rounding, so any final full refund reverses the commission
/// exactly and a sequence of partial refunds cannot accumulate rounding drift.
///
/// # Errors
///
/// Returns [`PaymentError::Invalid`] for inconsistent totals or arithmetic overflow.
pub fn calculate_commission_reversal(
    total_commission: i128,
    captured_amount: i128,
    already_reserved_refund: i128,
    already_reserved_reversal: i128,
    new_refund: i128,
) -> Result<i128, PaymentError> {
    if total_commission < 0
        || captured_amount <= 0
        || already_reserved_refund < 0
        || already_reserved_reversal < 0
        || new_refund <= 0
        || total_commission > captured_amount
    {
        return Err(PaymentError::Invalid(
            "commission reversal totals are inconsistent".to_owned(),
        ));
    }
    let cumulative_refund = already_reserved_refund
        .checked_add(new_refund)
        .ok_or_else(|| PaymentError::Invalid("refund arithmetic overflow".to_owned()))?;
    if cumulative_refund > captured_amount {
        return Err(PaymentError::Invalid(
            "refund exceeds captured amount".to_owned(),
        ));
    }
    let target_reversal = if cumulative_refund == captured_amount {
        total_commission
    } else {
        total_commission
            .checked_mul(cumulative_refund)
            .and_then(|value| value.checked_add(captured_amount / 2))
            .map(|value| value / captured_amount)
            .ok_or_else(|| {
                PaymentError::Invalid("commission reversal arithmetic overflow".to_owned())
            })?
    };
    target_reversal
        .checked_sub(already_reserved_reversal)
        .filter(|value| *value >= 0)
        .ok_or_else(|| PaymentError::Invalid("commission reversal exceeds commission".to_owned()))
}

/// Tokenized payment method selected by the buyer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaymentMethod {
    /// Provider-hosted card or network token flow.
    Card,
    /// WeChat Native QR checkout.
    WechatNative,
    /// WeChat JSAPI checkout.
    WechatJsapi {
        /// OpenID for the merchant AppID used by this checkout.
        payer_openid: String,
    },
    /// WeChat H5 checkout.
    WechatH5 {
        /// Buyer IP required by WeChat H5 payments.
        payer_client_ip: String,
        /// WeChat H5 scene type, normally `Wap` or `iOS`/`Android`.
        scene_type: String,
    },
    /// Alipay desktop website checkout.
    AlipayWeb,
    /// Alipay mobile website checkout.
    AlipayWap,
    /// EPay protocol method code, such as `alipay` or `wxpay`.
    Epay { method_code: String },
    /// Waffo payment method name/type pair.
    Waffo {
        /// Provider method name.
        method_name: Option<String>,
        /// Provider method type.
        method_type: String,
    },
    /// Opaque custom-adapter method code.
    Custom { method_code: String },
}

impl PaymentMethod {
    /// Stable routing code used by payment gateway configuration.
    #[must_use]
    pub fn routing_code(&self) -> &str {
        match self {
            Self::Card => "card",
            Self::WechatNative => "wechat_native",
            Self::WechatJsapi { .. } => "wechat_jsapi",
            Self::WechatH5 { .. } => "wechat_h5",
            Self::AlipayWeb => "alipay_web",
            Self::AlipayWap => "alipay_wap",
            Self::Epay { method_code } | Self::Custom { method_code } => method_code,
            Self::Waffo { method_type, .. } => method_type,
        }
    }
}

/// Secret provider token; its debug representation never reveals the value.
pub struct PaymentToken(SecretString);

impl PaymentToken {
    /// Wraps a token produced by a provider-hosted checkout or client SDK.
    #[must_use]
    pub fn new(value: impl Into<Box<str>>) -> Self {
        Self(SecretString::new(value.into()))
    }

    /// Borrows the protected token for an adapter request.
    #[must_use]
    pub fn expose(&self) -> &str {
        secrecy::ExposeSecret::expose_secret(&self.0)
    }
}

impl fmt::Debug for PaymentToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PaymentToken([REDACTED])")
    }
}

/// Normalized capabilities advertised by an adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct GatewayCapabilities {
    /// Funds can be authorized separately from capture.
    pub manual_capture: bool,
    /// An unpaid or authorized request can be voided.
    pub void: bool,
    /// Captured payments can be refunded.
    pub refund: bool,
    /// Partial captures are supported.
    pub partial_capture: bool,
    /// Partial refunds are supported.
    pub partial_refund: bool,
    /// Provider status can be reconciled after unknown outcomes.
    pub status_query: bool,
}

/// Stable non-secret gateway metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GatewayDescriptor {
    /// Configured gateway ID.
    pub gateway_id: PaymentGatewayId,
    /// Administrator-facing name.
    pub name: String,
    /// Built-in adapter kind.
    pub kind: GatewayKind,
    /// Test or production execution mode.
    pub mode: GatewayMode,
    /// Supported operations.
    pub capabilities: GatewayCapabilities,
}

/// Request to reserve buyer funds.
#[derive(Debug)]
pub struct AuthorizePayment {
    /// Platform payment ID.
    pub payment_id: PaymentId,
    /// Tenant routing boundary.
    pub tenant_id: TenantId,
    /// Provider-visible order reference.
    pub merchant_order_id: String,
    /// Required idempotency key.
    pub idempotency_key: String,
    /// Exact gross buyer amount.
    pub amount: Money,
    /// Buyer-selected method.
    pub method: PaymentMethod,
    /// Provider token only; raw card data is forbidden.
    pub payment_token: Option<PaymentToken>,
    /// Provider callback endpoint.
    pub notify_url: String,
    /// Buyer redirect endpoint.
    pub return_url: String,
    /// Human-readable item description.
    pub description: String,
    /// Request time.
    pub requested_at: OffsetDateTime,
}

/// Request to capture a prior authorization after a deterministic trade.
#[derive(Debug, Clone)]
pub struct CapturePayment {
    /// Platform payment ID.
    pub payment_id: PaymentId,
    /// Provider reference returned by authorization.
    pub provider_reference: String,
    /// Exact amount to capture.
    pub amount: Money,
    /// Original authorization ceiling, used by deterministic and constrained adapters.
    pub authorized_amount: Money,
    /// Required idempotency key.
    pub idempotency_key: String,
}

/// Request to release an unconsumed authorization.
#[derive(Debug, Clone)]
pub struct VoidPayment {
    /// Platform payment ID.
    pub payment_id: PaymentId,
    /// Provider reference returned by authorization.
    pub provider_reference: String,
    /// Required idempotency key.
    pub idempotency_key: String,
}

/// Request to refund captured buyer funds.
#[derive(Debug, Clone)]
pub struct RefundPayment {
    /// Stable refund ID.
    pub refund_id: RefundId,
    /// Original platform payment.
    pub payment_id: PaymentId,
    /// Provider payment reference.
    pub provider_reference: String,
    /// Exact full or partial refund amount.
    pub amount: Money,
    /// Original captured amount required by gateways such as WeChat Pay.
    pub captured_amount: Money,
    /// Required idempotency key.
    pub idempotency_key: String,
    /// Auditable reason without sensitive buyer data.
    pub reason: String,
    /// Provider callback endpoint for asynchronous refund completion.
    pub notify_url: Option<String>,
}

/// Request to reconcile provider state.
#[derive(Debug, Clone)]
pub struct QueryPayment {
    /// Platform payment ID.
    pub payment_id: PaymentId,
    /// Provider reference, when already assigned.
    pub provider_reference: Option<String>,
}

/// Raw provider callback passed to a gateway adapter for authentication and normalization.
///
/// The payment service deliberately keeps this transport-neutral so adapters can be exercised
/// without coupling the payment domain to Axum or another HTTP framework.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebhookRequest {
    /// Case-insensitive HTTP headers copied from the inbound request.
    pub headers: Vec<(String, String)>,
    /// Exact request body bytes used for signature verification.
    pub body: Vec<u8>,
}

impl WebhookRequest {
    /// Returns a header value using case-insensitive matching.
    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// Normalized, authenticated provider event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebhookEvent {
    /// Payment authorization/capture/status notification.
    Payment(PaymentWebhook),
    /// Refund status notification.
    Refund(RefundWebhook),
}

/// Normalized payment webhook after provider signature verification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaymentWebhook {
    /// Provider event id used for durable deduplication.
    pub provider_event_id: String,
    /// Provider event name retained for audit.
    pub event_type: String,
    /// Merchant order id, when the provider echoes it.
    pub merchant_order_id: Option<String>,
    /// Provider order reference, when distinct from the merchant order id.
    pub provider_reference: Option<String>,
    /// Normalized payment state.
    pub status: PaymentStatus,
    /// Provider state retained for reconciliation/audit.
    pub provider_status: String,
    /// Provider-reported amount, when available for invariant checks.
    pub amount: Option<Money>,
}

/// Normalized refund webhook after provider signature verification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefundWebhook {
    /// Provider event id used for durable deduplication.
    pub provider_event_id: String,
    /// Provider event name retained for audit.
    pub event_type: String,
    /// Original merchant order id, when available.
    pub merchant_order_id: Option<String>,
    /// Provider payment reference, when available.
    pub provider_reference: Option<String>,
    /// Our merchant refund reference, when echoed by the provider.
    pub refund_reference: Option<String>,
    /// Normalized refund state.
    pub status: RefundStatus,
    /// Provider state retained for reconciliation/audit.
    pub provider_status: String,
    /// Provider-reported refund amount, when available for invariant checks.
    pub amount: Option<Money>,
}

/// Provider-neutral payment state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaymentStatus {
    /// Buyer action, such as a hosted checkout redirect, is required.
    RequiresAction,
    /// Funds are reserved and may be captured.
    Authorized,
    /// Funds were captured.
    Captured,
    /// Authorization was released.
    Voided,
    /// Provider processing is asynchronous.
    Pending,
    /// Provider rejected or permanently failed the payment.
    Failed,
    /// The transport outcome is ambiguous and must be queried.
    Unknown,
}

impl PaymentStatus {
    /// Stable persistence code.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RequiresAction => "requires_action",
            Self::Authorized => "authorized",
            Self::Captured => "captured",
            Self::Voided => "voided",
            Self::Pending => "pending",
            Self::Failed => "failed",
            Self::Unknown => "unknown",
        }
    }
}

/// Normalized result of authorization, capture, void, or reconciliation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaymentOutcome {
    /// Platform payment ID.
    pub payment_id: PaymentId,
    /// Provider-assigned durable reference.
    pub provider_reference: String,
    /// Current normalized status.
    pub status: PaymentStatus,
    /// Hosted checkout or challenge URL, when buyer action is required.
    pub redirect_url: Option<String>,
    /// Provider status code retained for audit/reconciliation.
    pub provider_status: String,
}

/// Provider-neutral refund state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefundStatus {
    /// Provider accepted the request but has not finalized it.
    Pending,
    /// Funds were returned.
    Succeeded,
    /// Provider permanently rejected the refund.
    Failed,
    /// The outcome must be reconciled.
    Unknown,
}

/// Provider-neutral refund result with durable reconciliation identifiers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefundOutcome {
    /// Platform refund ID.
    pub refund_id: RefundId,
    /// Provider refund or request reference.
    pub provider_reference: String,
    /// Current normalized refund state.
    pub status: RefundStatus,
    /// Provider status retained for audit and reconciliation.
    pub provider_status: String,
}

impl RefundStatus {
    /// Stable persistence code.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Unknown => "unknown",
        }
    }
}

/// Provider health without secret or customer data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GatewayStatus {
    /// Gateway can accept traffic.
    pub healthy: bool,
    /// Redacted diagnostic status.
    pub message: String,
}

/// Invoice business purpose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InvoiceKind {
    /// A participant issues the sale/service invoice defined by the active domain.
    #[serde(alias = "vehicle_sale")]
    Sale,
    /// A domain-defined service, booking, rental, or other non-sale invoice.
    Service,
    /// Platform issues a commission/service invoice to the seller.
    PlatformCommission,
}

/// Auditable invoice lifecycle including refund corrections.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InvoiceStatus {
    /// Buyer or seller submitted invoice details.
    Requested,
    /// Issuer is reviewing invoice identity and tax details.
    Reviewing,
    /// Issuer or provider is processing the request.
    Issuing,
    /// Invoice artifact was issued.
    Issued,
    /// Issuance permanently failed.
    Failed,
    /// Unused invoice was voided.
    Voided,
    /// Refund correction was queued but not yet issued.
    RedLetterPending,
    /// A refund triggered a red-letter/credit-note correction.
    RedLettered,
}

impl InvoiceStatus {
    /// Stable persistence code.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Requested => "requested",
            Self::Reviewing => "reviewing",
            Self::Issuing => "issuing",
            Self::Issued => "issued",
            Self::Failed => "failed",
            Self::Voided => "voided",
            Self::RedLetterPending => "red_letter_pending",
            Self::RedLettered => "red_lettered",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn money_should_render_provider_decimal_without_float() {
        let money = Money::new(12_345, "CNY", 2).expect("test money is valid");

        assert_eq!(
            money
                .decimal_string()
                .expect("test money should render exactly"),
            "123.45"
        );
    }

    #[test]
    fn commission_should_round_to_nearest_minor_unit() {
        assert_eq!(
            calculate_commission(550, 100).expect("commission should be exact"),
            6
        );
        assert_eq!(
            calculate_commission(500, 100).expect("commission should be exact"),
            5
        );
    }

    #[test]
    fn partial_refunds_should_reverse_commission_without_rounding_drift() {
        let first = calculate_commission_reversal(7, 100, 0, 0, 33)
            .expect("first reversal should be valid");
        let second = calculate_commission_reversal(7, 100, 33, first, 33)
            .expect("second reversal should be valid");
        let final_part = calculate_commission_reversal(7, 100, 66, first + second, 34)
            .expect("final reversal should be valid");

        assert_eq!(first + second + final_part, 7);
    }
}

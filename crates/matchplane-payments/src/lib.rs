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

use std::net::IpAddr;

/// Validate an outbound provider endpoint before constructing an HTTP adapter.
///
/// Provider URLs are operator-controlled, but they still sit on a server-side request path. Keep
/// credentials and requests away from obvious local/link-local targets and do not permit URL
/// features (userinfo/fragments) that are not needed by provider adapters.
pub(crate) fn validate_https_url(value: &str, label: &str) -> Result<url::Url, PaymentError> {
    let url = url::Url::parse(value)
        .map_err(|error| PaymentError::Invalid(format!("{label} is invalid: {error}")))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(PaymentError::Invalid(format!(
            "{label} must use HTTPS, contain a host, and omit userinfo/fragments"
        )));
    }

    let host = url.host_str().expect("host checked above");
    let normalized_host = host.trim_end_matches('.').to_ascii_lowercase();
    if normalized_host == "localhost"
        || normalized_host.ends_with(".localhost")
        || normalized_host.ends_with(".local")
        || normalized_host.ends_with(".internal")
        || normalized_host.ends_with(".home.arpa")
        || normalized_host.ends_with(".lan")
    {
        return Err(PaymentError::Invalid(format!(
            "{label} must not target a local or internal hostname"
        )));
    }
    let ip_host = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = ip_host.parse::<IpAddr>() {
        let local = match ip {
            IpAddr::V4(address) => {
                address.is_private()
                    || address.is_loopback()
                    || address.is_link_local()
                    || address.is_unspecified()
            }
            IpAddr::V6(address) => {
                address.is_loopback()
                    || address.is_unique_local()
                    || address.is_unicast_link_local()
                    || address.is_unspecified()
                    || address.to_ipv4().is_some_and(|mapped| {
                        mapped.is_private()
                            || mapped.is_loopback()
                            || mapped.is_link_local()
                            || mapped.is_unspecified()
                    })
            }
        };
        if local {
            return Err(PaymentError::Invalid(format!(
                "{label} must not target a private, loopback, link-local, or unspecified address"
            )));
        }
    }
    Ok(url)
}

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

#[cfg(test)]
mod endpoint_tests {
    use super::validate_https_url;

    #[test]
    fn provider_endpoints_reject_local_targets_and_url_credentials() {
        for endpoint in [
            "http://payments.example.com",
            "https://127.0.0.1/api",
            "https://[::1]/api",
            "https://payments.internal/api",
            "https://user:secret@payments.example.com/api",
            "https://payments.example.com/api#fragment",
        ] {
            assert!(
                validate_https_url(endpoint, "provider endpoint").is_err(),
                "{endpoint}"
            );
        }
        assert!(
            validate_https_url("https://payments.example.com/api", "provider endpoint").is_ok()
        );
    }
}

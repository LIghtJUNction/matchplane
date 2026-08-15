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

use futures_util::StreamExt;
use std::{
    collections::BTreeSet,
    net::{IpAddr, SocketAddr, ToSocketAddrs},
    time::Duration,
};

pub(crate) const MAX_PROVIDER_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const MAX_INVOICE_PROVIDER_RESPONSE_BYTES: usize = 12 * 1024 * 1024;

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
    if let Ok(ip) = ip_host.parse::<IpAddr>()
        && is_forbidden_provider_address(ip)
    {
        return Err(PaymentError::Invalid(format!(
            "{label} must not target a private, loopback, link-local, reserved, or unspecified address"
        )));
    }
    Ok(url)
}

/// Build a provider HTTP client with a DNS result pinned for the lifetime of the client.
///
/// Provider endpoints are operator-controlled and may therefore resolve through an attacker
/// controlled DNS zone. We resolve the host once, reject every private/reserved answer, and pass
/// the complete validated result set to reqwest as an override. This prevents a later resolver
/// answer (including a DNS-rebinding answer) from redirecting credentials to a local or metadata
/// service. Environment proxies are disabled here because an implicit proxy would otherwise
/// perform a second, unvalidated resolution outside this process.
pub(crate) fn provider_http_client(
    value: &str,
    label: &str,
    timeout: Duration,
) -> Result<(url::Url, reqwest::Client), PaymentError> {
    let url = validate_https_url(value, label)?;
    let host = url
        .host_str()
        .ok_or_else(|| PaymentError::Invalid(format!("{label} must contain a host")))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| PaymentError::Invalid(format!("{label} must contain a valid port")))?;
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|error| PaymentError::Invalid(format!("{label} DNS resolution failed: {error}")))?
        .collect::<BTreeSet<SocketAddr>>();
    if addresses.is_empty() {
        return Err(PaymentError::Invalid(format!(
            "{label} did not resolve to an address"
        )));
    }
    if addresses
        .iter()
        .any(|address| is_forbidden_provider_address(address.ip()))
    {
        return Err(PaymentError::Invalid(format!(
            "{label} resolves to a private, loopback, link-local, reserved, or unspecified address"
        )));
    }

    let client = reqwest::Client::builder()
        .no_proxy()
        .resolve_to_addrs(host, &addresses.into_iter().collect::<Vec<_>>())
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .build()?;
    Ok((url, client))
}

/// Read a provider response with a hard aggregate limit, including chunked responses that do not
/// advertise a Content-Length. Provider data is untrusted and must be bounded before JSON,
/// signature, or invoice-artifact processing allocates additional memory.
pub(crate) async fn read_provider_body(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<Vec<u8>, PaymentError> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(PaymentError::Invalid(
            "provider response exceeds the configured size limit".to_owned(),
        ));
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if body.len().saturating_add(chunk.len()) > max_bytes {
            return Err(PaymentError::Invalid(
                "provider response exceeds the configured size limit".to_owned(),
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn is_forbidden_provider_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(address) => {
            let value = u32::from_be_bytes(address.octets());
            address.is_private()
                || address.is_loopback()
                || address.is_link_local()
                || address.is_unspecified()
                || value == u32::MAX
                || in_ipv4_range(value, 0, 8) // 0.0.0.0/8
                || in_ipv4_range(value, 0x6440_0000, 10) // 100.64.0.0/10 (CGNAT)
                || in_ipv4_range(value, 0xc000_0000, 24) // 192.0.0.0/24
                || in_ipv4_range(value, 0xc000_0200, 24) // 192.0.2.0/24 (documentation)
                || in_ipv4_range(value, 0xc01f_c400, 24) // 192.31.196.0/24 (AS112)
                || in_ipv4_range(value, 0xc034_c100, 24) // 192.52.193.0/24 (AS112)
                || in_ipv4_range(value, 0xc0af_3000, 24) // 192.175.48.0/24 (AS112)
                || in_ipv4_range(value, 0xc058_6300, 24) // 192.88.99.0/24 (deprecated anycast)
                || in_ipv4_range(value, 0xc612_0000, 15) // 198.18.0.0/15 (benchmarking)
                || in_ipv4_range(value, 0xc633_6400, 24) // 198.51.100.0/24 (documentation)
                || in_ipv4_range(value, 0xcb00_7100, 24) // 203.0.113.0/24 (documentation)
                || in_ipv4_range(value, 0xe000_0000, 4) // 224.0.0.0/4 (multicast)
                || in_ipv4_range(value, 0xf000_0000, 4) // 240.0.0.0/4 (reserved)
                || value == 0xa83f_8110 // 168.63.129.16 (Azure platform virtual IP)
        }
        IpAddr::V6(address) => {
            let segments = address.segments();
            address.is_loopback()
                || address.is_unique_local()
                || address.is_unicast_link_local()
                || address.is_unspecified()
                || address.to_ipv4().is_some()
                || segments[0] == 0
                || segments[0] & 0xfe00 == 0xfc00 // fc00::/7 (ULA)
                || segments[0] & 0xffc0 == 0xfe80 // fe80::/10 (link-local)
                || segments[0] & 0xff00 == 0xff00 // ff00::/8 (multicast)
                || (segments[0] == 0x2001 && segments[1] == 0x0db8) // 2001:db8::/32
                || (segments[0] == 0x2001
                    && segments[1] == 0x0002
                    && segments[2] == 0
                    && segments[3] == 0) // 2001:2::/48 (benchmarking)
                || (segments[0] == 0x2001
                    && (segments[1] & 0xfff0) == 0x0010) // 2001:10::/28 (ORCHID)
                || (segments[0] == 0x2001
                    && (segments[1] & 0xfff0) == 0x0020) // 2001:20::/28 (ORCHIDv2)
                || (segments[0] == 0x0100
                    && segments[1..].iter().all(|segment| *segment == 0)) // 100::/64 (discard-only)
                || (segments[0] & 0xffc0) == 0xfec0 // fec0::/10 (deprecated site-local)
                || (segments[0] == 0x0064
                    && segments[1] == 0xff9b
                    && segments[2..6].iter().all(|segment| *segment == 0)) // 64:ff9b::/96 (NAT64 well-known prefix)
                || (segments[0] == 0x0064
                    && segments[1] == 0xff9b
                    && segments[2] == 1) // 64:ff9b:1::/48 (NAT64 local-use prefix)
                || segments[0] == 0x2002 // 2002::/16 (6to4)
                || (segments[0] == 0x2001 && segments[1] == 0) // 2001::/32 (Teredo)
                || (segments[0] == 0x3fff && segments[1] & 0xfff0 == 0x0) // 3fff::/20 (documentation)
        }
    }
}

fn in_ipv4_range(value: u32, network: u32, prefix: u32) -> bool {
    let mask = if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    };
    value & mask == network & mask
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
    use std::net::IpAddr;

    use super::{is_forbidden_provider_address, provider_http_client, validate_https_url};

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

    #[test]
    fn resolved_provider_addresses_reject_non_global_destinations() {
        for address in [
            "0.0.0.0",
            "10.0.0.8",
            "100.64.0.8",
            "127.0.0.1",
            "169.254.169.254",
            "192.0.2.8",
            "198.18.0.8",
            "203.0.113.8",
            "192.31.196.8",
            "192.52.193.8",
            "192.175.48.8",
            "168.63.129.16",
            "224.0.0.1",
            "240.0.0.1",
            "::",
            "::1",
            "fc00::8",
            "fe80::8",
            "2001:db8::8",
            "ff02::1",
            "100::",
            "fec0::8",
            "64:ff9b::a9fe:a9fe",
            "64:ff9b:1::a9fe:a9fe",
            "2001::a9fe:a9fe",
            "2002:c000:0208::",
        ] {
            let address = address.parse::<IpAddr>().expect("test address is valid");
            assert!(
                is_forbidden_provider_address(address),
                "{address} must be rejected"
            );
        }
        for address in ["1.1.1.1", "8.8.8.8", "2001:4860:4860::8888"] {
            let address = address.parse::<IpAddr>().expect("test address is valid");
            assert!(
                !is_forbidden_provider_address(address),
                "{address} should be allowed"
            );
        }
    }

    #[test]
    fn provider_client_can_pin_a_public_literal_without_network_io() {
        let (url, _client) = provider_http_client(
            "https://1.1.1.1:8443/provider",
            "provider endpoint",
            std::time::Duration::from_secs(15),
        )
        .expect("public provider endpoint should construct");
        assert_eq!(url.host_str(), Some("1.1.1.1"));
        assert_eq!(url.port(), Some(8443));
    }
}

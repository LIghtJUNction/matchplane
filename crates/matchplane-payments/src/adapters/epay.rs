use std::{collections::BTreeMap, fmt, time::Duration};

use async_trait::async_trait;
use md5::{Digest, Md5};
use secrecy::{ExposeSecret, SecretString};
use serde_json::Value;

use crate::{
    AuthorizePayment, CapturePayment, GatewayDescriptor, GatewayKind, GatewayMode, GatewayStatus,
    PaymentError, PaymentGateway, PaymentMethod, PaymentOutcome, PaymentStatus, QueryPayment,
    RefundOutcome, RefundPayment, RefundStatus, VoidPayment,
};

use super::common::require_https;

/// EPay-compatible redirect, query, and refund adapter.
pub struct EpayGateway {
    descriptor: GatewayDescriptor,
    client: reqwest::Client,
    base_url: reqwest::Url,
    merchant_id: String,
    merchant_key: SecretString,
}

impl fmt::Debug for EpayGateway {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EpayGateway")
            .field("descriptor", &self.descriptor)
            .field("base_url", &self.base_url)
            .field("merchant_id", &self.merchant_id)
            .field("merchant_key", &"[REDACTED]")
            .finish()
    }
}

impl EpayGateway {
    /// Builds a production EPay adapter from a merchant secret.
    ///
    /// # Errors
    ///
    /// Returns [`PaymentError::Invalid`] unless the descriptor is a production EPay gateway with
    /// an HTTPS endpoint.
    pub fn new(
        descriptor: GatewayDescriptor,
        base_url: &str,
        merchant_id: impl Into<String>,
        merchant_key: SecretString,
    ) -> Result<Self, PaymentError> {
        if descriptor.kind != GatewayKind::Epay || descriptor.mode != GatewayMode::Production {
            return Err(PaymentError::Invalid(
                "EPay adapter requires a production epay descriptor".to_owned(),
            ));
        }
        require_https(base_url)?;
        Ok(Self {
            descriptor,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()?,
            base_url: reqwest::Url::parse(base_url).map_err(|error| {
                PaymentError::Invalid(format!("EPay base URL is invalid: {error}"))
            })?,
            merchant_id: merchant_id.into(),
            merchant_key,
        })
    }

    fn signed_parameters(
        &self,
        request: &AuthorizePayment,
        method_code: &str,
    ) -> Result<BTreeMap<String, String>, PaymentError> {
        let mut parameters = BTreeMap::from([
            ("name".to_owned(), request.description.clone()),
            ("money".to_owned(), request.amount.decimal_string()?),
            ("notify_url".to_owned(), request.notify_url.clone()),
            ("out_trade_no".to_owned(), request.merchant_order_id.clone()),
            ("pid".to_owned(), self.merchant_id.clone()),
            ("return_url".to_owned(), request.return_url.clone()),
            ("type".to_owned(), method_code.to_owned()),
        ]);
        let canonical = parameters
            .iter()
            .filter(|(_, value)| !value.is_empty())
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join("&");
        let mut hasher = Md5::new();
        hasher.update(canonical.as_bytes());
        hasher.update(self.merchant_key.expose_secret().as_bytes());
        parameters.insert("sign".to_owned(), hex::encode(hasher.finalize()));
        parameters.insert("sign_type".to_owned(), "MD5".to_owned());
        Ok(parameters)
    }

    fn api_url(&self) -> Result<reqwest::Url, PaymentError> {
        self.base_url
            .join("api.php")
            .map_err(|error| PaymentError::Invalid(format!("EPay API URL is invalid: {error}")))
    }
}

#[async_trait]
impl PaymentGateway for EpayGateway {
    fn descriptor(&self) -> &GatewayDescriptor {
        &self.descriptor
    }

    async fn authorize(&self, request: &AuthorizePayment) -> Result<PaymentOutcome, PaymentError> {
        let PaymentMethod::Epay { method_code } = &request.method else {
            return Err(PaymentError::Unsupported {
                gateway: "epay",
                operation: "selected payment method",
            });
        };
        let parameters = self.signed_parameters(request, method_code)?;
        let mut redirect = self.base_url.join("submit.php").map_err(|error| {
            PaymentError::Invalid(format!("EPay submit URL is invalid: {error}"))
        })?;
        redirect.query_pairs_mut().extend_pairs(parameters.iter());
        Ok(PaymentOutcome {
            payment_id: request.payment_id,
            provider_reference: request.merchant_order_id.clone(),
            status: PaymentStatus::RequiresAction,
            redirect_url: Some(redirect.to_string()),
            provider_status: "checkout_required".to_owned(),
        })
    }

    async fn capture(&self, _request: &CapturePayment) -> Result<PaymentOutcome, PaymentError> {
        Err(PaymentError::Unsupported {
            gateway: "epay",
            operation: "manual capture",
        })
    }

    async fn void(&self, _request: &VoidPayment) -> Result<PaymentOutcome, PaymentError> {
        Err(PaymentError::Unsupported {
            gateway: "epay",
            operation: "authorization void",
        })
    }

    async fn refund(&self, request: &RefundPayment) -> Result<RefundOutcome, PaymentError> {
        let response = self
            .client
            .post(self.api_url()?)
            .form(&BTreeMap::from([
                ("act", "refund".to_owned()),
                ("pid", self.merchant_id.clone()),
                ("key", self.merchant_key.expose_secret().to_owned()),
                ("out_trade_no", request.provider_reference.clone()),
                ("money", request.amount.decimal_string()?),
            ]))
            .send()
            .await?;
        let status = response.status();
        let body: Value = response.json().await?;
        if !status.is_success() {
            return Err(PaymentError::UnknownOutcome);
        }
        match body.get("code").and_then(Value::as_i64) {
            Some(1) => Ok(RefundOutcome {
                refund_id: request.refund_id,
                provider_reference: body
                    .get("trade_no")
                    .or_else(|| body.get("out_trade_no"))
                    .and_then(Value::as_str)
                    .unwrap_or(&request.provider_reference)
                    .to_owned(),
                status: RefundStatus::Succeeded,
                provider_status: "succeeded".to_owned(),
            }),
            Some(_) => Err(PaymentError::ProviderRejected {
                code: body
                    .get("code")
                    .map(Value::to_string)
                    .unwrap_or_else(|| "unknown".to_owned()),
                message: body
                    .get("msg")
                    .and_then(Value::as_str)
                    .unwrap_or("EPay refund failed")
                    .to_owned(),
            }),
            None => Err(PaymentError::UnknownOutcome),
        }
    }

    async fn query(&self, request: &QueryPayment) -> Result<PaymentOutcome, PaymentError> {
        let reference = request.provider_reference.as_deref().ok_or_else(|| {
            PaymentError::Invalid("EPay query needs an order reference".to_owned())
        })?;
        let response = self
            .client
            .post(self.api_url()?)
            .form(&BTreeMap::from([
                ("act", "order".to_owned()),
                ("pid", self.merchant_id.clone()),
                ("key", self.merchant_key.expose_secret().to_owned()),
                ("out_trade_no", reference.to_owned()),
            ]))
            .send()
            .await?;
        let status = response.status();
        let body: Value = response.json().await?;
        if !status.is_success() {
            return Err(PaymentError::UnknownOutcome);
        }
        let paid = body.get("status").and_then(Value::as_i64) == Some(1)
            || body.get("trade_status").and_then(Value::as_str) == Some("TRADE_SUCCESS");
        Ok(PaymentOutcome {
            payment_id: request.payment_id,
            // The EPay query and refund APIs below address an order by `out_trade_no`.
            // Keep that merchant reference stable instead of replacing it with `trade_no`.
            provider_reference: reference.to_owned(),
            status: if paid {
                PaymentStatus::Captured
            } else {
                PaymentStatus::Pending
            },
            redirect_url: None,
            provider_status: body
                .get("trade_status")
                .map(Value::to_string)
                .unwrap_or_else(|| "pending".to_owned()),
        })
    }

    async fn health(&self) -> Result<GatewayStatus, PaymentError> {
        Ok(GatewayStatus {
            healthy: true,
            message: "EPay production configuration loaded".to_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use matchplane_domain::{PaymentGatewayId, PaymentId, TenantId};
    use secrecy::SecretString;
    use time::OffsetDateTime;

    use super::*;
    use crate::GatewayCapabilities;

    #[test]
    fn epay_redirect_should_contain_signature_without_leaking_key() {
        let gateway = EpayGateway::new(
            GatewayDescriptor {
                gateway_id: PaymentGatewayId::new(),
                name: "epay".to_owned(),
                kind: GatewayKind::Epay,
                mode: GatewayMode::Production,
                capabilities: GatewayCapabilities {
                    manual_capture: false,
                    void: false,
                    refund: true,
                    partial_capture: false,
                    partial_refund: false,
                    status_query: true,
                },
            },
            "https://pay.example.invalid/",
            "merchant",
            SecretString::new("secret-key".into()),
        )
        .expect("test gateway is valid");
        let request = AuthorizePayment {
            payment_id: PaymentId::new(),
            tenant_id: TenantId::new(),
            merchant_order_id: "order-1".to_owned(),
            idempotency_key: "idem-1".to_owned(),
            amount: crate::Money::new(10_000, "CNY", 2).expect("test money is valid"),
            method: PaymentMethod::Epay {
                method_code: "alipay".to_owned(),
            },
            payment_token: None,
            notify_url: "https://merchant.invalid/notify".to_owned(),
            return_url: "https://merchant.invalid/return".to_owned(),
            description: "car".to_owned(),
            requested_at: OffsetDateTime::now_utc(),
        };

        let parameters = gateway
            .signed_parameters(&request, "alipay")
            .expect("parameters should sign");

        assert_eq!(parameters.get("sign_type").map(String::as_str), Some("MD5"));
        assert_ne!(
            parameters.get("sign").map(String::as_str),
            Some("secret-key")
        );
    }
}

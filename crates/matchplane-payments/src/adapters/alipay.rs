use std::{collections::BTreeMap, fmt, time::Duration};

use async_trait::async_trait;
use secrecy::SecretString;
use serde_json::{Value, json};
use time::{OffsetDateTime, UtcOffset, format_description};

use crate::{
    AuthorizePayment, CapturePayment, GatewayDescriptor, GatewayKind, GatewayMode, GatewayStatus,
    PaymentError, PaymentGateway, PaymentMethod, PaymentOutcome, PaymentStatus, QueryPayment,
    RefundOutcome, RefundPayment, RefundStatus, VoidPayment,
};

use super::common::{require_https, sign_rsa_sha256, verify_rsa_sha256};

/// Direct Alipay OpenAPI RSA2 adapter for website and mobile website payments.
pub struct AlipayGateway {
    descriptor: GatewayDescriptor,
    client: reqwest::Client,
    gateway_url: reqwest::Url,
    app_id: String,
    merchant_private_key: SecretString,
    alipay_public_key: String,
}

impl fmt::Debug for AlipayGateway {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AlipayGateway")
            .field("descriptor", &self.descriptor)
            .field("gateway_url", &self.gateway_url)
            .field("app_id", &self.app_id)
            .field("credentials", &"[REDACTED]")
            .finish()
    }
}

impl AlipayGateway {
    /// Builds an Alipay OpenAPI production adapter.
    ///
    /// # Errors
    ///
    /// Returns [`PaymentError::Invalid`] for the wrong kind/mode or non-HTTPS gateway URL.
    pub fn new(
        descriptor: GatewayDescriptor,
        gateway_url: &str,
        app_id: impl Into<String>,
        merchant_private_key: SecretString,
        alipay_public_key: impl Into<String>,
    ) -> Result<Self, PaymentError> {
        if descriptor.kind != GatewayKind::AlipayOpenapi
            || descriptor.mode != GatewayMode::Production
        {
            return Err(PaymentError::Invalid(
                "Alipay adapter requires a production alipay_openapi descriptor".to_owned(),
            ));
        }
        require_https(gateway_url)?;
        Ok(Self {
            descriptor,
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()?,
            gateway_url: reqwest::Url::parse(gateway_url).map_err(|error| {
                PaymentError::Invalid(format!("Alipay gateway URL is invalid: {error}"))
            })?,
            app_id: app_id.into(),
            merchant_private_key,
            alipay_public_key: alipay_public_key.into(),
        })
    }

    fn parameters(
        &self,
        method: &str,
        biz_content: Value,
    ) -> Result<BTreeMap<String, String>, PaymentError> {
        let description = format_description::parse_borrowed::<2>(
            "[year]-[month]-[day] [hour]:[minute]:[second]",
        )
        .map_err(|error| PaymentError::Invalid(error.to_string()))?;
        let china_standard_time = UtcOffset::from_hms(8, 0, 0)
            .map_err(|error| PaymentError::Invalid(error.to_string()))?;
        let timestamp = OffsetDateTime::now_utc()
            .to_offset(china_standard_time)
            .format(&description)
            .map_err(|error| PaymentError::Invalid(error.to_string()))?;
        Ok(BTreeMap::from([
            ("app_id".to_owned(), self.app_id.clone()),
            (
                "biz_content".to_owned(),
                serde_json::to_string(&biz_content)?,
            ),
            ("charset".to_owned(), "utf-8".to_owned()),
            ("format".to_owned(), "JSON".to_owned()),
            ("method".to_owned(), method.to_owned()),
            ("sign_type".to_owned(), "RSA2".to_owned()),
            ("timestamp".to_owned(), timestamp),
            ("version".to_owned(), "1.0".to_owned()),
        ]))
    }

    fn sign_parameters(
        &self,
        parameters: &mut BTreeMap<String, String>,
    ) -> Result<(), PaymentError> {
        let canonical = parameters
            .iter()
            .filter(|(key, value)| key.as_str() != "sign" && !value.is_empty())
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join("&");
        let signature = sign_rsa_sha256(&self.merchant_private_key, canonical.as_bytes())?;
        parameters.insert("sign".to_owned(), signature);
        Ok(())
    }

    async fn call(&self, method: &str, biz_content: Value) -> Result<Value, PaymentError> {
        let mut parameters = self.parameters(method, biz_content)?;
        self.sign_parameters(&mut parameters)?;
        let response = self
            .client
            .post(self.gateway_url.clone())
            .form(&parameters)
            .send()
            .await?;
        let status = response.status();
        let body = response.bytes().await?;
        let value: Value = serde_json::from_slice(&body)?;
        let response_key = format!("{}_response", method.replace('.', "_"));
        let response_value = value.get(&response_key).ok_or_else(|| {
            PaymentError::Invalid(format!("Alipay response omitted {response_key}"))
        })?;
        let signature = value
            .get("sign")
            .and_then(Value::as_str)
            .ok_or(PaymentError::Signature)?;
        let signed_content = extract_signed_response(&body, &response_key)?;
        verify_rsa_sha256(&self.alipay_public_key, &signed_content, signature)?;
        if !status.is_success()
            || response_value.get("code").and_then(Value::as_str) != Some("10000")
        {
            return Err(PaymentError::ProviderRejected {
                code: response_value
                    .get("sub_code")
                    .or_else(|| response_value.get("code"))
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_owned(),
                message: response_value
                    .get("sub_msg")
                    .or_else(|| response_value.get("msg"))
                    .and_then(Value::as_str)
                    .unwrap_or("Alipay rejected the request")
                    .to_owned(),
            });
        }
        Ok(response_value.clone())
    }

    fn query_outcome(
        payment_id: matchplane_domain::PaymentId,
        provider_reference: String,
        value: &Value,
    ) -> PaymentOutcome {
        let provider_status = value
            .get("trade_status")
            .and_then(Value::as_str)
            .unwrap_or("WAIT_BUYER_PAY")
            .to_owned();
        let status = match provider_status.as_str() {
            "TRADE_SUCCESS" | "TRADE_FINISHED" => PaymentStatus::Captured,
            "TRADE_CLOSED" => PaymentStatus::Voided,
            "WAIT_BUYER_PAY" => PaymentStatus::RequiresAction,
            _ => PaymentStatus::Unknown,
        };
        PaymentOutcome {
            payment_id,
            provider_reference,
            status,
            redirect_url: None,
            provider_status,
        }
    }
}

fn extract_signed_response(body: &[u8], response_key: &str) -> Result<Vec<u8>, PaymentError> {
    let marker = format!("\"{response_key}\":");
    let start = body
        .windows(marker.len())
        .position(|window| window == marker.as_bytes())
        .map(|position| position + marker.len())
        .ok_or(PaymentError::Signature)?;
    let value_start = body[start..]
        .iter()
        .position(|byte| !byte.is_ascii_whitespace())
        .map(|offset| start + offset)
        .ok_or(PaymentError::Signature)?;
    let mut stream =
        serde_json::Deserializer::from_slice(&body[value_start..]).into_iter::<serde_json::Value>();
    stream.next().transpose()?.ok_or(PaymentError::Signature)?;
    let value_end = value_start + stream.byte_offset();
    Ok(body[value_start..value_end].to_vec())
}

#[async_trait]
impl PaymentGateway for AlipayGateway {
    fn descriptor(&self) -> &GatewayDescriptor {
        &self.descriptor
    }

    async fn authorize(&self, request: &AuthorizePayment) -> Result<PaymentOutcome, PaymentError> {
        let (method, product_code) = match request.method {
            PaymentMethod::AlipayWeb => ("alipay.trade.page.pay", "FAST_INSTANT_TRADE_PAY"),
            PaymentMethod::AlipayWap => ("alipay.trade.wap.pay", "QUICK_WAP_WAY"),
            _ => {
                return Err(PaymentError::Unsupported {
                    gateway: "alipay_openapi",
                    operation: "selected payment method",
                });
            }
        };
        let mut parameters = self.parameters(
            method,
            json!({
                "out_trade_no": request.merchant_order_id,
                "total_amount": request.amount.decimal_string()?,
                "subject": request.description,
                "product_code": product_code,
            }),
        )?;
        parameters.insert("notify_url".to_owned(), request.notify_url.clone());
        parameters.insert("return_url".to_owned(), request.return_url.clone());
        self.sign_parameters(&mut parameters)?;
        let mut redirect = self.gateway_url.clone();
        redirect.query_pairs_mut().extend_pairs(parameters.iter());
        Ok(PaymentOutcome {
            payment_id: request.payment_id,
            provider_reference: request.merchant_order_id.clone(),
            status: PaymentStatus::RequiresAction,
            redirect_url: Some(redirect.to_string()),
            provider_status: "WAIT_BUYER_PAY".to_owned(),
        })
    }

    async fn capture(&self, _request: &CapturePayment) -> Result<PaymentOutcome, PaymentError> {
        Err(PaymentError::Unsupported {
            gateway: "alipay_openapi",
            operation: "manual capture",
        })
    }

    async fn void(&self, request: &VoidPayment) -> Result<PaymentOutcome, PaymentError> {
        self.call(
            "alipay.trade.close",
            json!({"out_trade_no": request.provider_reference}),
        )
        .await?;
        Ok(PaymentOutcome {
            payment_id: request.payment_id,
            provider_reference: request.provider_reference.clone(),
            status: PaymentStatus::Voided,
            redirect_url: None,
            provider_status: "TRADE_CLOSED".to_owned(),
        })
    }

    async fn refund(&self, request: &RefundPayment) -> Result<RefundOutcome, PaymentError> {
        let response = self
            .call(
                "alipay.trade.refund",
                json!({
                    "out_trade_no": request.provider_reference,
                    "refund_amount": request.amount.decimal_string()?,
                    "refund_reason": request.reason,
                    "out_request_no": request.refund_id.to_string(),
                }),
            )
            .await?;
        let status = if response.get("fund_change").and_then(Value::as_str) == Some("Y") {
            RefundStatus::Succeeded
        } else {
            RefundStatus::Pending
        };
        Ok(RefundOutcome {
            refund_id: request.refund_id,
            provider_reference: response
                .get("trade_no")
                .and_then(Value::as_str)
                .unwrap_or(request.idempotency_key.as_str())
                .to_owned(),
            status,
            provider_status: response
                .get("fund_change")
                .and_then(Value::as_str)
                .unwrap_or("N")
                .to_owned(),
        })
    }

    async fn query(&self, request: &QueryPayment) -> Result<PaymentOutcome, PaymentError> {
        let reference = request
            .provider_reference
            .as_deref()
            .ok_or_else(|| PaymentError::Invalid("Alipay query needs out_trade_no".to_owned()))?;
        let response = self
            .call("alipay.trade.query", json!({"out_trade_no": reference}))
            .await?;
        Ok(Self::query_outcome(
            request.payment_id,
            reference.to_owned(),
            &response,
        ))
    }

    async fn health(&self) -> Result<GatewayStatus, PaymentError> {
        Ok(GatewayStatus {
            healthy: true,
            message: "Alipay OpenAPI adapter configuration and RSA2 keys loaded".to_owned(),
        })
    }
}

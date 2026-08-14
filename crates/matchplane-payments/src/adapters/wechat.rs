use std::{fmt, time::SystemTime};

use async_trait::async_trait;
use secrecy::SecretString;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    AuthorizePayment, CapturePayment, GatewayDescriptor, GatewayKind, GatewayMode, GatewayStatus,
    PaymentError, PaymentGateway, PaymentMethod, PaymentOutcome, PaymentStatus, QueryPayment,
    RefundOutcome, RefundPayment, RefundStatus, VoidPayment,
};

use super::common::{require_https, sign_rsa_sha256, verify_rsa_sha256};

/// Direct WeChat Pay API v3 adapter for Native, JSAPI, and H5 checkout.
pub struct WechatPayGateway {
    descriptor: GatewayDescriptor,
    client: reqwest::Client,
    base_url: reqwest::Url,
    app_id: String,
    merchant_id: String,
    merchant_serial: String,
    merchant_private_key: SecretString,
    platform_serial: String,
    platform_public_key: String,
}

impl fmt::Debug for WechatPayGateway {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WechatPayGateway")
            .field("descriptor", &self.descriptor)
            .field("base_url", &self.base_url)
            .field("app_id", &self.app_id)
            .field("merchant_id", &self.merchant_id)
            .field("merchant_serial", &self.merchant_serial)
            .field("credentials", &"[REDACTED]")
            .finish()
    }
}

impl WechatPayGateway {
    /// Builds a direct WeChat Pay API v3 adapter.
    ///
    /// # Errors
    ///
    /// Returns [`PaymentError::Invalid`] for the wrong gateway mode/kind or a non-HTTPS URL.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        descriptor: GatewayDescriptor,
        base_url: &str,
        app_id: impl Into<String>,
        merchant_id: impl Into<String>,
        merchant_serial: impl Into<String>,
        merchant_private_key: SecretString,
        platform_serial: impl Into<String>,
        platform_public_key: impl Into<String>,
    ) -> Result<Self, PaymentError> {
        if descriptor.kind != GatewayKind::WechatPayV3 || descriptor.mode != GatewayMode::Production
        {
            return Err(PaymentError::Invalid(
                "WeChat Pay adapter requires a production wechat_pay_v3 descriptor".to_owned(),
            ));
        }
        require_https(base_url)?;
        Ok(Self {
            descriptor,
            client: reqwest::Client::builder().build()?,
            base_url: reqwest::Url::parse(base_url).map_err(|error| {
                PaymentError::Invalid(format!("WeChat Pay base URL is invalid: {error}"))
            })?,
            app_id: app_id.into(),
            merchant_id: merchant_id.into(),
            merchant_serial: merchant_serial.into(),
            merchant_private_key,
            platform_serial: platform_serial.into(),
            platform_public_key: platform_public_key.into(),
        })
    }

    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        query: Option<&[(&str, &str)]>,
        body: Option<&Value>,
    ) -> Result<Value, PaymentError> {
        let mut url = self.base_url.join(path).map_err(|error| {
            PaymentError::Invalid(format!("WeChat Pay endpoint is invalid: {error}"))
        })?;
        if let Some(query) = query {
            url.query_pairs_mut().extend_pairs(query.iter().copied());
        }
        let body_bytes = body
            .map(serde_json::to_vec)
            .transpose()?
            .unwrap_or_default();
        let timestamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_err(|error| PaymentError::Invalid(format!("system clock is invalid: {error}")))?
            .as_secs();
        let nonce = Uuid::now_v7().simple().to_string();
        let canonical_target = match url.query() {
            Some(query) => format!("{}?{query}", url.path()),
            None => url.path().to_owned(),
        };
        let message = format!(
            "{}\n{}\n{timestamp}\n{nonce}\n{}\n",
            method.as_str(),
            canonical_target,
            String::from_utf8_lossy(&body_bytes)
        );
        let signature = sign_rsa_sha256(&self.merchant_private_key, message.as_bytes())?;
        let authorization = format!(
            "WECHATPAY2-SHA256-RSA2048 mchid=\"{}\",nonce_str=\"{nonce}\",timestamp=\"{timestamp}\",serial_no=\"{}\",signature=\"{signature}\"",
            self.merchant_id, self.merchant_serial
        );
        let mut request = self
            .client
            .request(method, url)
            .header(reqwest::header::AUTHORIZATION, authorization)
            .header(reqwest::header::ACCEPT, "application/json");
        if !body_bytes.is_empty() {
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body_bytes);
        }
        let response = request.send().await?;
        let status = response.status();
        let headers = response.headers().clone();
        let response_bytes = response.bytes().await?;
        self.verify_response(&headers, &response_bytes)?;
        let value = if response_bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&response_bytes)?
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
                    .and_then(Value::as_str)
                    .unwrap_or("WeChat Pay rejected the request")
                    .to_owned(),
            });
        }
        Ok(value)
    }

    fn verify_response(
        &self,
        headers: &reqwest::header::HeaderMap,
        body: &[u8],
    ) -> Result<(), PaymentError> {
        let header = |name: &'static str| {
            headers
                .get(name)
                .and_then(|value| value.to_str().ok())
                .ok_or(PaymentError::Signature)
        };
        let timestamp = header("Wechatpay-Timestamp")?;
        let nonce = header("Wechatpay-Nonce")?;
        let signature = header("Wechatpay-Signature")?;
        if header("Wechatpay-Serial")? != self.platform_serial {
            return Err(PaymentError::Signature);
        }
        let message = format!("{timestamp}\n{nonce}\n{}\n", String::from_utf8_lossy(body));
        verify_rsa_sha256(&self.platform_public_key, message.as_bytes(), signature)
    }

    fn payment_outcome(
        payment_id: matchplane_domain::PaymentId,
        provider_reference: String,
        value: &Value,
    ) -> PaymentOutcome {
        let provider_status = value
            .get("trade_state")
            .and_then(Value::as_str)
            .unwrap_or("CHECKOUT_CREATED")
            .to_owned();
        let status = match provider_status.as_str() {
            "SUCCESS" | "REFUND" => PaymentStatus::Captured,
            "CLOSED" | "REVOKED" => PaymentStatus::Voided,
            "PAYERROR" => PaymentStatus::Failed,
            "USERPAYING" => PaymentStatus::Pending,
            "NOTPAY" | "CHECKOUT_CREATED" => PaymentStatus::RequiresAction,
            _ => PaymentStatus::Unknown,
        };
        let redirect_url = value
            .get("code_url")
            .or_else(|| value.get("h5_url"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                value
                    .get("prepay_id")
                    .and_then(Value::as_str)
                    .map(|prepay_id| format!("wechatpay://prepay/{prepay_id}"))
            });
        PaymentOutcome {
            payment_id,
            provider_reference,
            status,
            redirect_url,
            provider_status,
        }
    }
}

#[async_trait]
impl PaymentGateway for WechatPayGateway {
    fn descriptor(&self) -> &GatewayDescriptor {
        &self.descriptor
    }

    async fn authorize(&self, request: &AuthorizePayment) -> Result<PaymentOutcome, PaymentError> {
        if request.amount.scale != 2 {
            return Err(PaymentError::Invalid(
                "WeChat Pay amount must use two decimal places".to_owned(),
            ));
        }
        let mut body = json!({
            "appid": self.app_id,
            "mchid": self.merchant_id,
            "description": request.description,
            "out_trade_no": request.merchant_order_id,
            "notify_url": request.notify_url,
            "amount": {
                "total": request.amount.exact_amount()?,
                "currency": request.amount.currency,
            }
        });
        let path = match &request.method {
            PaymentMethod::WechatNative => "v3/pay/transactions/native",
            PaymentMethod::WechatJsapi { payer_openid } => {
                body["payer"] = json!({"openid": payer_openid});
                "v3/pay/transactions/jsapi"
            }
            PaymentMethod::WechatH5 {
                payer_client_ip,
                scene_type,
            } => {
                body["scene_info"] = json!({
                    "payer_client_ip": payer_client_ip,
                    "h5_info": {"type": scene_type}
                });
                "v3/pay/transactions/h5"
            }
            _ => {
                return Err(PaymentError::Unsupported {
                    gateway: "wechat_pay_v3",
                    operation: "selected payment method",
                });
            }
        };
        let response = self
            .request(reqwest::Method::POST, path, None, Some(&body))
            .await?;
        Ok(Self::payment_outcome(
            request.payment_id,
            request.merchant_order_id.clone(),
            &response,
        ))
    }

    async fn capture(&self, _request: &CapturePayment) -> Result<PaymentOutcome, PaymentError> {
        Err(PaymentError::Unsupported {
            gateway: "wechat_pay_v3",
            operation: "manual capture",
        })
    }

    async fn void(&self, request: &VoidPayment) -> Result<PaymentOutcome, PaymentError> {
        let path = format!(
            "v3/pay/transactions/out-trade-no/{}/close",
            request.provider_reference
        );
        self.request(
            reqwest::Method::POST,
            &path,
            None,
            Some(&json!({"mchid": self.merchant_id})),
        )
        .await?;
        Ok(PaymentOutcome {
            payment_id: request.payment_id,
            provider_reference: request.provider_reference.clone(),
            status: PaymentStatus::Voided,
            redirect_url: None,
            provider_status: "CLOSED".to_owned(),
        })
    }

    async fn refund(&self, request: &RefundPayment) -> Result<RefundOutcome, PaymentError> {
        if request.amount.currency != request.captured_amount.currency
            || request.amount.scale != request.captured_amount.scale
        {
            return Err(PaymentError::Invalid(
                "refund and captured money must use the same currency and scale".to_owned(),
            ));
        }
        let mut body = json!({
            "out_refund_no": request.refund_id.to_string(),
            "out_trade_no": request.provider_reference,
            "reason": request.reason,
            "amount": {
                "refund": request.amount.exact_amount()?,
                "total": request.captured_amount.exact_amount()?,
                "currency": request.amount.currency,
            }
        });
        if let Some(notify_url) = &request.notify_url {
            body["notify_url"] = Value::String(notify_url.clone());
        }
        let response = self
            .request(
                reqwest::Method::POST,
                "v3/refund/domestic/refunds",
                None,
                Some(&body),
            )
            .await?;
        let provider_status = response
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("PROCESSING")
            .to_owned();
        let status = match provider_status.as_str() {
            "SUCCESS" => RefundStatus::Succeeded,
            "CLOSED" | "ABNORMAL" => RefundStatus::Failed,
            "PROCESSING" => RefundStatus::Pending,
            _ => RefundStatus::Unknown,
        };
        Ok(RefundOutcome {
            refund_id: request.refund_id,
            provider_reference: response
                .get("refund_id")
                .or_else(|| response.get("out_refund_no"))
                .and_then(Value::as_str)
                .unwrap_or(request.idempotency_key.as_str())
                .to_owned(),
            status,
            provider_status,
        })
    }

    async fn query(&self, request: &QueryPayment) -> Result<PaymentOutcome, PaymentError> {
        let reference = request.provider_reference.as_deref().ok_or_else(|| {
            PaymentError::Invalid("WeChat Pay query needs out_trade_no".to_owned())
        })?;
        let path = format!("v3/pay/transactions/out-trade-no/{reference}");
        let response = self
            .request(
                reqwest::Method::GET,
                &path,
                Some(&[("mchid", self.merchant_id.as_str())]),
                None,
            )
            .await?;
        Ok(Self::payment_outcome(
            request.payment_id,
            reference.to_owned(),
            &response,
        ))
    }

    async fn health(&self) -> Result<GatewayStatus, PaymentError> {
        Ok(GatewayStatus {
            healthy: true,
            message: "WeChat Pay adapter configuration and RSA keys loaded".to_owned(),
        })
    }
}

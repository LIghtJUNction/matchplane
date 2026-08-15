use std::fmt;

use async_trait::async_trait;
use secrecy::{ExposeSecret, SecretString};
use serde_json::{Value, json};
use time::format_description::well_known::Rfc3339;

use crate::{
    AuthorizePayment, CapturePayment, GatewayDescriptor, GatewayKind, GatewayMode, GatewayStatus,
    PaymentError, PaymentGateway, PaymentMethod, PaymentOutcome, PaymentStatus, PaymentWebhook,
    QueryPayment, RefundOutcome, RefundPayment, RefundStatus, RefundWebhook, VoidPayment,
    WebhookEvent, WebhookRequest,
};

use super::common::{provider_client, sign_rsa_sha256, verify_rsa_sha256};

/// Waffo Pancake signed REST adapter with manual authorization/capture support.
pub struct WaffoGateway {
    descriptor: GatewayDescriptor,
    client: reqwest::Client,
    base_url: reqwest::Url,
    merchant_id: String,
    api_key: SecretString,
    private_key: SecretString,
    waffo_public_key: String,
}

impl fmt::Debug for WaffoGateway {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WaffoGateway")
            .field("descriptor", &self.descriptor)
            .field("base_url", &self.base_url)
            .field("merchant_id", &self.merchant_id)
            .field("credentials", &"[REDACTED]")
            .finish()
    }
}

impl WaffoGateway {
    /// Builds a production Waffo Pancake adapter.
    ///
    /// # Errors
    ///
    /// Returns [`PaymentError::Invalid`] for the wrong adapter kind/mode or a non-HTTPS URL.
    pub fn new(
        descriptor: GatewayDescriptor,
        base_url: &str,
        merchant_id: impl Into<String>,
        api_key: SecretString,
        private_key: SecretString,
        waffo_public_key: impl Into<String>,
    ) -> Result<Self, PaymentError> {
        if descriptor.kind != GatewayKind::WaffoPancake
            || descriptor.mode != GatewayMode::Production
        {
            return Err(PaymentError::Invalid(
                "Waffo adapter requires a production waffo_pancake descriptor".to_owned(),
            ));
        }
        let (base_url, client) = provider_client(base_url)?;
        Ok(Self {
            descriptor,
            client,
            base_url,
            merchant_id: merchant_id.into(),
            api_key,
            private_key,
            waffo_public_key: waffo_public_key.into(),
        })
    }

    async fn post(&self, path: &str, body: &Value) -> Result<Value, PaymentError> {
        let bytes = serde_json::to_vec(body)?;
        let signature = sign_rsa_sha256(&self.private_key, &bytes)?;
        let response = self
            .client
            .post(self.base_url.join(path).map_err(|error| {
                PaymentError::Invalid(format!("Waffo endpoint is invalid: {error}"))
            })?)
            .header("X-API-KEY", self.api_key.expose_secret())
            .header("X-SIGNATURE", signature)
            .header("X-API-VERSION", "1.0.0")
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(bytes)
            .send()
            .await?;
        let status = response.status();
        let response_signature = response
            .headers()
            .get("X-SIGNATURE")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
            .ok_or(PaymentError::Signature)?;
        let response_bytes =
            crate::read_provider_body(response, crate::MAX_PROVIDER_RESPONSE_BYTES).await?;
        verify_rsa_sha256(&self.waffo_public_key, &response_bytes, &response_signature)?;
        let value: Value = serde_json::from_slice(&response_bytes)?;
        if !status.is_success() {
            return Err(PaymentError::UnknownOutcome);
        }
        if value.get("code").and_then(Value::as_str) != Some("0") {
            return Err(PaymentError::ProviderRejected {
                code: value
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_owned(),
                message: value
                    .get("msg")
                    .and_then(Value::as_str)
                    .unwrap_or("Waffo rejected the request")
                    .to_owned(),
            });
        }
        Ok(value)
    }

    fn outcome(
        payment_id: matchplane_domain::PaymentId,
        data: &Value,
    ) -> Result<PaymentOutcome, PaymentError> {
        let provider_status = data
            .get("orderStatus")
            .and_then(Value::as_str)
            .unwrap_or("UNKNOWN")
            .to_owned();
        let status = match provider_status.as_str() {
            "AUTHED_WAITING_CAPTURE" => PaymentStatus::Authorized,
            "PAY_SUCCESS" => PaymentStatus::Captured,
            "AUTHORIZATION_REQUIRED" => PaymentStatus::RequiresAction,
            "ORDER_CLOSE" => PaymentStatus::Failed,
            _ => PaymentStatus::Pending,
        };
        let redirect_url = data
            .get("orderAction")
            .and_then(Value::as_str)
            .and_then(|action| serde_json::from_str::<Value>(action).ok())
            .and_then(|action| {
                action
                    .get("redirectUrl")
                    .or_else(|| action.get("paymentUrl"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
        let provider_reference = data
            .get("acquiringOrderId")
            .or_else(|| data.get("merchantOrderId"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                PaymentError::Invalid("Waffo response omitted its order reference".to_owned())
            })?
            .to_owned();
        Ok(PaymentOutcome {
            payment_id,
            provider_reference,
            status,
            redirect_url,
            provider_status,
        })
    }
}

#[async_trait]
impl PaymentGateway for WaffoGateway {
    fn descriptor(&self) -> &GatewayDescriptor {
        &self.descriptor
    }

    async fn authorize(&self, request: &AuthorizePayment) -> Result<PaymentOutcome, PaymentError> {
        let PaymentMethod::Waffo {
            method_name,
            method_type,
        } = &request.method
        else {
            return Err(PaymentError::Unsupported {
                gateway: "waffo_pancake",
                operation: "selected payment method",
            });
        };
        let requested_at = request
            .requested_at
            .format(&Rfc3339)
            .map_err(|error| PaymentError::Invalid(error.to_string()))?;
        let body = json!({
            "paymentRequestId": request.payment_id.to_string().replace('-', ""),
            "merchantOrderId": request.merchant_order_id,
            "orderCurrency": request.amount.currency,
            "orderAmount": request.amount.decimal_string()?,
            "orderDescription": request.description,
            "orderRequestedAt": requested_at,
            "notifyUrl": request.notify_url,
            "returnUrl": request.return_url,
            "merchantInfo": {"merchantId": self.merchant_id},
            "paymentInfo": {
                "productType": "ONE_TIME_PAYMENT",
                "payMethodType": method_type,
                "payMethodName": method_name,
                "captureMode": "manualCapture"
            },
            "userInfo": {"userId": request.tenant_id.to_string()}
        });
        let response = self.post("api/v1/order/create", &body).await?;
        Self::outcome(
            request.payment_id,
            response.get("data").unwrap_or(&Value::Null),
        )
    }

    async fn capture(&self, request: &CapturePayment) -> Result<PaymentOutcome, PaymentError> {
        let body = json!({
            "paymentRequestId": request.payment_id.to_string().replace('-', ""),
            "acquiringOrderId": request.provider_reference,
            "merchantId": self.merchant_id,
            "captureRequestedAt": time::OffsetDateTime::now_utc()
                .format(&Rfc3339)
                .map_err(|error| PaymentError::Invalid(error.to_string()))?,
            "captureAmount": request.amount.decimal_string()?
        });
        let response = self.post("api/v1/order/capture", &body).await?;
        Self::outcome(
            request.payment_id,
            response.get("data").unwrap_or(&Value::Null),
        )
    }

    async fn void(&self, request: &VoidPayment) -> Result<PaymentOutcome, PaymentError> {
        let body = json!({
            "paymentRequestId": request.payment_id.to_string().replace('-', ""),
            "acquiringOrderId": request.provider_reference,
            "merchantId": self.merchant_id
        });
        let response = self.post("api/v1/order/cancel", &body).await?;
        Self::outcome(
            request.payment_id,
            response.get("data").unwrap_or(&Value::Null),
        )
    }

    async fn refund(&self, request: &RefundPayment) -> Result<RefundOutcome, PaymentError> {
        let body = json!({
            "refundRequestId": request.refund_id.to_string().replace('-', ""),
            "paymentRequestId": request.payment_id.to_string().replace('-', ""),
            "acquiringOrderId": request.provider_reference,
            "merchantId": self.merchant_id,
            "refundAmount": request.amount.decimal_string()?,
            "refundReason": request.reason,
            "refundRequestedAt": time::OffsetDateTime::now_utc()
                .format(&Rfc3339)
                .map_err(|error| PaymentError::Invalid(error.to_string()))?
        });
        let response = self.post("api/v1/order/refund", &body).await?;
        let data = response.get("data").unwrap_or(&Value::Null);
        let provider_status = data
            .get("refundStatus")
            .and_then(Value::as_str)
            .unwrap_or("PROCESSING")
            .to_owned();
        let status = match provider_status.as_str() {
            "REFUND_SUCCESS" | "SUCCESS" => RefundStatus::Succeeded,
            "REFUND_FAIL" | "FAILED" => RefundStatus::Failed,
            _ => RefundStatus::Pending,
        };
        Ok(RefundOutcome {
            refund_id: request.refund_id,
            provider_reference: data
                .get("acquiringRefundId")
                .or_else(|| data.get("refundRequestId"))
                .and_then(Value::as_str)
                .unwrap_or(request.idempotency_key.as_str())
                .to_owned(),
            status,
            provider_status,
        })
    }

    async fn query(&self, request: &QueryPayment) -> Result<PaymentOutcome, PaymentError> {
        let body = json!({
            "paymentRequestId": request.payment_id.to_string().replace('-', ""),
            "acquiringOrderId": request.provider_reference,
            "merchantId": self.merchant_id
        });
        let response = self.post("api/v1/order/inquiry", &body).await?;
        Self::outcome(
            request.payment_id,
            response.get("data").unwrap_or(&Value::Null),
        )
    }

    async fn health(&self) -> Result<GatewayStatus, PaymentError> {
        Ok(GatewayStatus {
            healthy: true,
            message: "Waffo production configuration and signing keys loaded".to_owned(),
        })
    }

    fn webhook(&self, request: &WebhookRequest) -> Result<WebhookEvent, PaymentError> {
        let signature = request
            .header("X-SIGNATURE")
            .ok_or(PaymentError::Signature)?;
        verify_rsa_sha256(&self.waffo_public_key, &request.body, signature)?;
        let value: Value = serde_json::from_slice(&request.body)?;
        let data = value.get("data").unwrap_or(&value);
        if let Some(merchant_id) = data
            .get("merchantId")
            .or_else(|| data.get("merchant_id"))
            .and_then(Value::as_str)
            && merchant_id != self.merchant_id
        {
            return Err(PaymentError::Signature);
        }
        let provider_event_id = data
            .get("eventId")
            .or_else(|| data.get("id"))
            .or_else(|| value.get("eventId"))
            .and_then(Value::as_str)
            .or_else(|| data.get("acquiringOrderId").and_then(Value::as_str))
            .ok_or_else(|| {
                PaymentError::Invalid("Waffo webhook omitted event identity".to_owned())
            })?
            .to_owned();
        let merchant_order_id = data
            .get("merchantOrderId")
            .or_else(|| data.get("merchant_order_id"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let provider_reference = data
            .get("acquiringOrderId")
            .or_else(|| data.get("transactionId"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        if data.get("refundStatus").is_some() || data.get("acquiringRefundId").is_some() {
            let provider_status = data
                .get("refundStatus")
                .and_then(Value::as_str)
                .unwrap_or("PROCESSING");
            let status = match provider_status {
                "REFUND_SUCCESS" | "SUCCESS" => RefundStatus::Succeeded,
                "REFUND_FAIL" | "FAILED" => RefundStatus::Failed,
                _ => RefundStatus::Pending,
            };
            let amount = data
                .get("refundAmount")
                .or_else(|| data.get("refund_amount"))
                .and_then(Value::as_str)
                .map(|value| {
                    super::common::decimal_money(
                        value,
                        data.get("currency")
                            .or_else(|| data.get("orderCurrency"))
                            .and_then(Value::as_str)
                            .unwrap_or("CNY"),
                        2,
                    )
                })
                .transpose()?;
            return Ok(WebhookEvent::Refund(RefundWebhook {
                provider_event_id,
                event_type: "waffo.refund".to_owned(),
                merchant_order_id,
                provider_reference,
                refund_reference: data
                    .get("acquiringRefundId")
                    .or_else(|| data.get("refundRequestId"))
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                status,
                provider_status: provider_status.to_owned(),
                amount,
            }));
        }
        let provider_status = data
            .get("orderStatus")
            .or_else(|| data.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("UNKNOWN");
        let status = match provider_status {
            "PAY_SUCCESS" | "SUCCESS" => PaymentStatus::Captured,
            "AUTHED_WAITING_CAPTURE" => PaymentStatus::Authorized,
            "AUTHORIZATION_REQUIRED" => PaymentStatus::RequiresAction,
            "ORDER_CLOSE" | "CLOSED" => PaymentStatus::Voided,
            "FAILED" | "PAY_ERROR" => PaymentStatus::Failed,
            _ => PaymentStatus::Pending,
        };
        let amount = data
            .get("orderAmount")
            .or_else(|| data.get("amount"))
            .and_then(Value::as_str)
            .map(|value| {
                super::common::decimal_money(
                    value,
                    data.get("orderCurrency")
                        .or_else(|| data.get("currency"))
                        .and_then(Value::as_str)
                        .unwrap_or("CNY"),
                    2,
                )
            })
            .transpose()?;
        Ok(WebhookEvent::Payment(PaymentWebhook {
            provider_event_id,
            event_type: "waffo.payment".to_owned(),
            merchant_order_id,
            provider_reference,
            status,
            provider_status: provider_status.to_owned(),
            amount,
        }))
    }
}

use std::{str::FromStr, sync::Arc};

use axum::{
    Json,
    body::{Body, Bytes},
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use matchplane_config::Environment;
use matchplane_domain::{InvoiceId, MarketplacePartyId, OfflineDealId, PaymentId, RefundId};
use matchplane_payments::{
    AuthorizePayment, CapturePayment, GatewayKind, GatewayMode, HttpInvoiceProvider, InvoiceKind,
    InvoiceProvider, InvoiceRecipient, IssueInvoice, Money, PaymentError, PaymentMethod,
    PaymentToken, QueryPayment, RefundPayment, TestInvoiceProvider, WebhookRequest,
};
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;
use url::Url;

use crate::{
    AppState,
    admin::{
        GatewayMutation, GatewayRecord, InvoiceModeSwitch, InvoiceProviderMutation,
        InvoiceProviderRecord, InvoiceSetting, ModeSwitch, PaymentSetting, RouteMutation,
        RouteRecord,
    },
    gateways::GatewayFactory,
    invoices::{EncryptedArtifact, InvoiceRecord, NewInvoice, invoice_kind},
    store::{NewPayment, NewRefund, PaymentRecord, RefundRecord, StoreError, is_unknown},
};

#[derive(Deserialize, Serialize)]
pub struct AuthorizeRequest {
    payment_id: Option<String>,
    tenant_id: String,
    offline_deal_id: Option<String>,
    payer_party_id: Option<String>,
    merchant_order_id: String,
    idempotency_key: String,
    transaction_channel: String,
    purpose: String,
    amount: Money,
    commission_amount: String,
    method: PaymentMethod,
    payment_token: Option<String>,
    notify_url: String,
    return_url: String,
    description: String,
    #[serde(default, with = "time::serde::rfc3339::option")]
    requested_at: Option<OffsetDateTime>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct CaptureRequest {
    tenant_id: String,
    idempotency_key: String,
    amount: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct ReconcileRequest {
    tenant_id: String,
    idempotency_key: String,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct RefundRequest {
    refund_id: Option<String>,
    tenant_id: String,
    idempotency_key: String,
    amount: String,
    reason: String,
    notify_url: Option<String>,
}

#[derive(Deserialize, Serialize)]
pub struct CreateInvoiceRequest {
    invoice_id: Option<String>,
    tenant_id: String,
    payment_id: Option<String>,
    offline_deal_id: Option<String>,
    kind: InvoiceKind,
    idempotency_key: String,
    amount: Money,
    description: String,
    billing_details: InvoiceRecipient,
    requested_by: String,
}

#[derive(Debug, Deserialize)]
pub struct InvoiceActionRequest {
    actor: String,
}

#[derive(Debug, Deserialize)]
pub struct ArtifactQuery {
    artifact: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TenantQuery {
    tenant_id: matchplane_domain::TenantId,
}

#[derive(Debug, Serialize)]
pub struct PaymentResponse {
    #[serde(flatten)]
    payment: PaymentRecord,
    duplicate: bool,
}

#[derive(Debug, Serialize)]
pub struct RefundResponse {
    #[serde(flatten)]
    refund: RefundRecord,
    duplicate: bool,
}

#[derive(Debug, Serialize)]
pub struct InvoiceResponse {
    #[serde(flatten)]
    invoice: InvoiceRecord,
    duplicate: bool,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: &'static str,
    error: String,
}

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_request",
            message: message.into(),
        }
    }

    fn unauthorized() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "unauthorized",
            message: "valid administrator bearer authentication is required".to_owned(),
        }
    }

    fn party_unauthorized() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "party_unauthorized",
            message: "valid seller bearer authentication is required for offline commission"
                .to_owned(),
        }
    }

    fn gateway(error: &PaymentError) -> Self {
        match error {
            PaymentError::Invalid(message) => Self::bad_request(message.clone()),
            PaymentError::IdempotencyConflict | PaymentError::InvalidTransition { .. } => Self {
                status: StatusCode::CONFLICT,
                code: "payment_conflict",
                message: error.to_string(),
            },
            PaymentError::Unsupported { .. } => Self {
                status: StatusCode::UNPROCESSABLE_ENTITY,
                code: "unsupported_gateway_operation",
                message: error.to_string(),
            },
            PaymentError::ProviderRejected { .. } => Self {
                status: StatusCode::PAYMENT_REQUIRED,
                code: "provider_rejected",
                message: error.to_string(),
            },
            PaymentError::UnknownOutcome | PaymentError::Transport(_) => Self {
                status: StatusCode::BAD_GATEWAY,
                code: "provider_outcome_unknown",
                message: "payment provider outcome is unknown; reconciliation is queued".to_owned(),
            },
            PaymentError::Credential(_) | PaymentError::Signature | PaymentError::Json(_) => Self {
                status: StatusCode::BAD_GATEWAY,
                code: "gateway_configuration_error",
                message: "payment gateway configuration or trusted response is invalid".to_owned(),
            },
            PaymentError::NotFound(resource) => Self {
                status: StatusCode::NOT_FOUND,
                code: "not_found",
                message: format!("{resource} was not found"),
            },
        }
    }
}

impl From<StoreError> for ApiError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::NotFound(resource) => Self {
                status: StatusCode::NOT_FOUND,
                code: "not_found",
                message: format!("{resource} was not found"),
            },
            StoreError::IdempotencyConflict => Self {
                status: StatusCode::CONFLICT,
                code: "idempotency_conflict",
                message: error.to_string(),
            },
            StoreError::Conflict(message) => Self {
                status: StatusCode::CONFLICT,
                code: "payment_conflict",
                message,
            },
            StoreError::Invalid(message) => Self::bad_request(message),
            StoreError::Payment(payment) => Self::gateway(&payment),
            StoreError::Database(database) => {
                tracing::error!(error = %database, "payment database operation failed");
                Self {
                    status: StatusCode::INTERNAL_SERVER_ERROR,
                    code: "database_error",
                    message: "payment persistence failed".to_owned(),
                }
            }
            StoreError::Json(json) => {
                tracing::error!(error = %json, "payment audit JSON conversion failed");
                Self::internal("payment audit serialization failed")
            }
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                code: self.code,
                error: self.message,
            }),
        )
            .into_response()
    }
}

pub async fn authorize(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<AuthorizeRequest>,
) -> Result<(StatusCode, Json<PaymentResponse>), ApiError> {
    validate_payment_request(
        &request,
        state.payment_callback_origin.as_ref(),
        state.environment,
    )?;
    let request_hash = hash(&request)?;
    let payment_id = parse_optional_id::<PaymentId>(request.payment_id.as_deref())?
        .unwrap_or_else(PaymentId::new);
    let tenant_id = parse_id(&request.tenant_id)?;
    let offline_deal_id = parse_optional_id(request.offline_deal_id.as_deref())?;
    let payer_party_id =
        parse_optional_id::<MarketplacePartyId>(request.payer_party_id.as_deref())?;
    if let Some(payer_party_id) = payer_party_id {
        require_marketplace_party(&state, &headers, tenant_id, payer_party_id).await?;
    } else {
        require_admin(&state, &headers)?;
    }
    let amount = validated_amount(&request.amount)?;
    let commission_amount = exact(&request.commission_amount, "commission_amount")?;
    if commission_amount < 0 || commission_amount > amount {
        return Err(ApiError::bad_request(
            "commission_amount must be between zero and amount",
        ));
    }
    if request.purpose == "platform_commission" && commission_amount != amount {
        return Err(ApiError::bad_request(
            "platform_commission payments must set commission_amount equal to amount",
        ));
    }
    let prepared = state
        .store
        .prepare_authorization(&NewPayment {
            payment_id,
            tenant_id,
            offline_deal_id,
            payer_party_id,
            merchant_order_id: request.merchant_order_id.clone(),
            idempotency_key: request.idempotency_key.clone(),
            request_hash,
            transaction_channel: request.transaction_channel.clone(),
            purpose: request.purpose.clone(),
            payment_method: request.method.routing_code().to_owned(),
            amount,
            commission_amount,
            currency: request.amount.currency.clone(),
            currency_scale: i16::from(request.amount.scale),
        })
        .await?;
    if prepared.duplicate {
        return Ok((
            StatusCode::OK,
            Json(PaymentResponse {
                payment: prepared.payment,
                duplicate: true,
            }),
        ));
    }
    let gateway = build_gateway(&state, &prepared.gateway).await?;
    let result = gateway
        .authorize(&AuthorizePayment {
            payment_id,
            tenant_id,
            merchant_order_id: request.merchant_order_id,
            idempotency_key: request.idempotency_key,
            amount: request.amount,
            method: request.method,
            payment_token: request.payment_token.map(PaymentToken::new),
            notify_url: request.notify_url,
            return_url: request.return_url,
            description: request.description,
            requested_at: request.requested_at.unwrap_or_else(OffsetDateTime::now_utc),
        })
        .await;
    match result {
        Ok(outcome) => {
            let payment = state.store.complete_authorization(&outcome).await?;
            Ok((
                StatusCode::CREATED,
                Json(PaymentResponse {
                    payment,
                    duplicate: false,
                }),
            ))
        }
        Err(error) => {
            state
                .store
                .fail_authorization(payment_id, is_unknown(&error), "provider_error")
                .await?;
            Err(ApiError::gateway(&error))
        }
    }
}

/// Receives an authenticated provider callback. This endpoint intentionally has no administrator
/// bearer requirement; the selected gateway's signature and the durable inbox provide the trust
/// boundary instead.
pub async fn payment_webhook(
    State(state): State<Arc<AppState>>,
    Path(gateway_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let gateway_id = parse_id(&gateway_id)?;
    let config = state.store.webhook_gateway(gateway_id).await?;
    let gateway = build_gateway(&state, &config).await?;
    let request = WebhookRequest {
        headers: headers
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.as_str().to_owned(), value.to_owned()))
            })
            .collect(),
        body: body.to_vec(),
    };
    let event = gateway.webhook(&request).map_err(|error| {
        if matches!(error, PaymentError::Signature) {
            ApiError {
                status: StatusCode::UNAUTHORIZED,
                code: "invalid_webhook_signature",
                message: "provider webhook signature could not be verified".to_owned(),
            }
        } else {
            ApiError::gateway(&error)
        }
    })?;
    let payload_hash = Sha256::digest(&request.body);
    let receipt = state
        .store
        .process_webhook(gateway_id, &event, payload_hash.as_slice())
        .await
        .map_err(ApiError::from)?;
    if receipt.status == "processing" {
        return Err(ApiError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "webhook_in_progress",
            message: "webhook is already being processed; retry the delivery".to_owned(),
        });
    }
    Ok(match config.kind {
        GatewayKind::Epay | GatewayKind::AlipayOpenapi => (
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            "success",
        )
            .into_response(),
        GatewayKind::WechatPayV3 => Json(serde_json::json!({
            "code": "SUCCESS",
            "message": "成功",
            "duplicate": receipt.duplicate,
        }))
        .into_response(),
        GatewayKind::WaffoPancake => Json(serde_json::json!({
            "code": "0",
            "message": "success",
            "duplicate": receipt.duplicate,
        }))
        .into_response(),
        GatewayKind::Test | GatewayKind::Custom => Json(receipt).into_response(),
    })
}

pub async fn payment(
    State(state): State<Arc<AppState>>,
    Path(payment_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<PaymentRecord>, ApiError> {
    require_admin(&state, &headers)?;
    state
        .store
        .payment(parse_id(&payment_id)?)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

pub async fn reconcile(
    State(state): State<Arc<AppState>>,
    Path(payment_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<ReconcileRequest>,
) -> Result<Json<PaymentResponse>, ApiError> {
    require_admin(&state, &headers)?;
    if request.idempotency_key.trim().is_empty() || request.idempotency_key.len() > 200 {
        return Err(ApiError::bad_request(
            "idempotency_key must contain 1..=200 bytes",
        ));
    }
    let payment_id = parse_id(&payment_id)?;
    let tenant_id = parse_id(&request.tenant_id)?;
    let request_hash = hash(&(payment_id, &request))?;
    let prepared = state
        .store
        .prepare_query(
            tenant_id,
            payment_id,
            &request.idempotency_key,
            &request_hash,
        )
        .await?;
    if !prepared.execute {
        return Ok(Json(PaymentResponse {
            payment: prepared.payment,
            duplicate: true,
        }));
    }
    let gateway = build_gateway(&state, &prepared.gateway).await?;
    if !gateway.descriptor().capabilities.status_query {
        let error = PaymentError::Unsupported {
            gateway: gateway.descriptor().kind.as_str(),
            operation: "status query",
        };
        state
            .store
            .complete_query(payment_id, &request.idempotency_key, Err(&error))
            .await?;
        return Err(ApiError::gateway(&error));
    }
    let result = gateway
        .query(&QueryPayment {
            payment_id,
            provider_reference: prepared.payment.provider_reference,
        })
        .await;
    match result {
        Ok(outcome) => {
            let payment = state
                .store
                .complete_query(payment_id, &request.idempotency_key, Ok(&outcome))
                .await?;
            Ok(Json(PaymentResponse {
                payment,
                duplicate: false,
            }))
        }
        Err(error) => {
            state
                .store
                .complete_query(payment_id, &request.idempotency_key, Err(&error))
                .await?;
            Err(ApiError::gateway(&error))
        }
    }
}

pub async fn capture(
    State(state): State<Arc<AppState>>,
    Path(payment_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<CaptureRequest>,
) -> Result<Json<PaymentResponse>, ApiError> {
    require_admin(&state, &headers)?;
    let payment_id = parse_id(&payment_id)?;
    let tenant_id = parse_id(&request.tenant_id)?;
    let amount = exact_positive(&request.amount, "amount")?;
    let request_hash = hash(&(payment_id, &request))?;
    let prepared = state
        .store
        .prepare_capture(
            tenant_id,
            payment_id,
            &request.idempotency_key,
            &request_hash,
            amount,
        )
        .await?;
    if !prepared.execute {
        return Ok(Json(PaymentResponse {
            payment: prepared.payment,
            duplicate: true,
        }));
    }
    let gateway = build_gateway(&state, &prepared.gateway).await?;
    if !gateway.descriptor().capabilities.manual_capture {
        return Err(ApiError::gateway(&PaymentError::Unsupported {
            gateway: gateway.descriptor().kind.as_str(),
            operation: "manual capture",
        }));
    }
    let reference = prepared
        .payment
        .provider_reference
        .as_deref()
        .ok_or_else(|| ApiError::bad_request("payment has no provider reference"))?;
    let capture_request = CapturePayment {
        payment_id,
        provider_reference: reference.to_owned(),
        amount: Money::new(
            amount,
            prepared.payment.currency.clone(),
            u8::try_from(prepared.payment.currency_scale)
                .map_err(|_| ApiError::bad_request("invalid stored currency scale"))?,
        )
        .map_err(|error| ApiError::gateway(&error))?,
        authorized_amount: Money::new(
            exact(&prepared.payment.amount, "stored amount")?,
            prepared.payment.currency.clone(),
            u8::try_from(prepared.payment.currency_scale)
                .map_err(|_| ApiError::bad_request("invalid stored currency scale"))?,
        )
        .map_err(|error| ApiError::gateway(&error))?,
        idempotency_key: request.idempotency_key.clone(),
    };
    match gateway.capture(&capture_request).await {
        Ok(outcome) => {
            let payment = state
                .store
                .complete_capture(payment_id, &request.idempotency_key, amount, Ok(&outcome))
                .await?;
            Ok(Json(PaymentResponse {
                payment,
                duplicate: false,
            }))
        }
        Err(error) => {
            state
                .store
                .complete_capture(payment_id, &request.idempotency_key, amount, Err(&error))
                .await?;
            Err(ApiError::gateway(&error))
        }
    }
}

pub async fn refund(
    State(state): State<Arc<AppState>>,
    Path(payment_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<RefundRequest>,
) -> Result<(StatusCode, Json<RefundResponse>), ApiError> {
    require_admin(&state, &headers)?;
    let payment_id = parse_id(&payment_id)?;
    let requested_refund_id =
        parse_optional_id::<RefundId>(request.refund_id.as_deref())?.unwrap_or_else(RefundId::new);
    let tenant_id = parse_id(&request.tenant_id)?;
    let amount = exact_positive(&request.amount, "amount")?;
    if let Some(notify_url) = request.notify_url.as_deref() {
        validate_callback_url(
            notify_url,
            "notify_url",
            state.payment_callback_origin.as_ref(),
            state.environment,
        )?;
    }
    if request.reason.trim().is_empty() || request.reason.len() > 2_000 {
        return Err(ApiError::bad_request(
            "refund reason must contain 1..=2000 bytes",
        ));
    }
    let request_hash = hash(&(payment_id, &request))?;
    let prepared = state
        .store
        .prepare_refund(&NewRefund {
            refund_id: requested_refund_id,
            tenant_id,
            payment_id,
            idempotency_key: request.idempotency_key.clone(),
            request_hash,
            amount,
            reason: request.reason.clone(),
        })
        .await?;
    // Retries after an unknown provider outcome must reuse the durable refund identifier returned
    // by the idempotency record; generating a fresh provider request number could double-refund.
    let refund_id = prepared.refund.refund_id;
    if !prepared.execute {
        return Ok((
            StatusCode::OK,
            Json(RefundResponse {
                refund: prepared.refund,
                duplicate: true,
            }),
        ));
    }
    let gateway = build_gateway(&state, &prepared.gateway).await?;
    if !gateway.descriptor().capabilities.refund {
        return Err(ApiError::gateway(&PaymentError::Unsupported {
            gateway: gateway.descriptor().kind.as_str(),
            operation: "refund",
        }));
    }
    let scale = u8::try_from(prepared.payment.currency_scale)
        .map_err(|_| ApiError::bad_request("invalid stored currency scale"))?;
    let provider_reference = prepared
        .payment
        .provider_reference
        .clone()
        .ok_or_else(|| ApiError::bad_request("payment has no provider reference"))?;
    let provider_request = RefundPayment {
        refund_id,
        payment_id,
        provider_reference,
        amount: Money::new(amount, prepared.payment.currency.clone(), scale)
            .map_err(|error| ApiError::gateway(&error))?,
        captured_amount: Money::new(
            exact(&prepared.payment.captured_amount, "captured_amount")?,
            prepared.payment.currency,
            scale,
        )
        .map_err(|error| ApiError::gateway(&error))?,
        idempotency_key: request.idempotency_key,
        reason: request.reason,
        notify_url: request.notify_url,
    };
    match gateway.refund(&provider_request).await {
        Ok(outcome) => {
            let refund = state.store.complete_refund(refund_id, Ok(&outcome)).await?;
            Ok((
                StatusCode::ACCEPTED,
                Json(RefundResponse {
                    refund,
                    duplicate: false,
                }),
            ))
        }
        Err(error) => {
            state.store.complete_refund(refund_id, Err(&error)).await?;
            Err(ApiError::gateway(&error))
        }
    }
}

pub async fn get_refund(
    State(state): State<Arc<AppState>>,
    Path(refund_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<RefundRecord>, ApiError> {
    require_admin(&state, &headers)?;
    state
        .store
        .refund(parse_id(&refund_id)?)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

pub async fn create_invoice(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<CreateInvoiceRequest>,
) -> Result<(StatusCode, Json<InvoiceResponse>), ApiError> {
    require_admin(&state, &headers)?;
    if request.idempotency_key.trim().is_empty() || request.idempotency_key.len() > 200 {
        return Err(ApiError::bad_request(
            "idempotency_key must contain 1..=200 bytes",
        ));
    }
    if request.description.trim().is_empty() || request.description.len() > 1_000 {
        return Err(ApiError::bad_request(
            "description must contain 1..=1000 bytes",
        ));
    }
    if request.requested_by.trim().is_empty() || request.requested_by.len() > 256 {
        return Err(ApiError::bad_request(
            "requested_by must contain 1..=256 bytes",
        ));
    }
    let request_hash = hash(&request)?;
    let invoice_id = parse_optional_id::<InvoiceId>(request.invoice_id.as_deref())?
        .unwrap_or_else(InvoiceId::new);
    let tenant_id = parse_id(&request.tenant_id)?;
    let payment_id = parse_optional_id::<PaymentId>(request.payment_id.as_deref())?;
    let offline_deal_id = parse_optional_id::<OfflineDealId>(request.offline_deal_id.as_deref())?;
    let amount = validated_amount(&request.amount)?;
    let billing = serde_json::to_vec(&request.billing_details)
        .map_err(|_| ApiError::bad_request("billing details could not be encoded"))?;
    let encrypted = state
        .invoice_cipher
        .encrypt(&billing, invoice_aad(tenant_id, invoice_id).as_bytes())
        .map_err(|error| {
            tracing::error!(error = %error, "invoice billing details encryption failed");
            ApiError::internal("invoice billing details could not be protected")
        })?;
    let prepared = state
        .invoices
        .request(&NewInvoice {
            invoice_id,
            tenant_id,
            payment_id,
            offline_deal_id,
            kind: request.kind,
            idempotency_key: request.idempotency_key,
            request_hash,
            amount,
            currency: request.amount.currency,
            currency_scale: i16::from(request.amount.scale),
            description: request.description,
            billing_details_ciphertext: encrypted.ciphertext,
            billing_details_nonce: encrypted.nonce.to_vec(),
            encryption_key_version: encrypted.key_version,
            requested_by: request.requested_by,
        })
        .await?;
    Ok((
        if prepared.duplicate {
            StatusCode::OK
        } else {
            StatusCode::CREATED
        },
        Json(InvoiceResponse {
            invoice: prepared.invoice,
            duplicate: prepared.duplicate,
        }),
    ))
}

pub async fn get_invoice(
    State(state): State<Arc<AppState>>,
    Path(invoice_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<InvoiceRecord>, ApiError> {
    require_admin(&state, &headers)?;
    state
        .invoices
        .invoice(parse_id(&invoice_id)?)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

pub async fn invoice_corrections(
    State(state): State<Arc<AppState>>,
    Path(invoice_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Vec<InvoiceRecord>>, ApiError> {
    require_admin(&state, &headers)?;
    state
        .invoices
        .corrections(parse_id(&invoice_id)?)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

pub async fn issue_invoice(
    State(state): State<Arc<AppState>>,
    Path(invoice_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<InvoiceActionRequest>,
) -> Result<Json<InvoiceResponse>, ApiError> {
    require_admin(&state, &headers)?;
    validate_actor(&request.actor)?;
    let invoice_id = parse_id(&invoice_id)?;
    let invoice = state
        .invoices
        .begin_issue(invoice_id, &request.actor)
        .await?;
    let provider = invoice_provider(&state, &invoice).await?;
    let issue_request = issue_request(&state, &invoice)?;
    match provider.issue(&issue_request).await {
        Ok(outcome) => {
            let artifact = outcome
                .artifact
                .as_ref()
                .map(|artifact| encrypt_artifact(&state, invoice_id, "invoice", artifact))
                .transpose()?;
            let invoice = state
                .invoices
                .complete_issue(&outcome, artifact.as_ref(), &request.actor)
                .await?;
            Ok(Json(InvoiceResponse {
                invoice,
                duplicate: false,
            }))
        }
        Err(error) => {
            state
                .invoices
                .fail_issue(invoice_id, "provider issuance failed", &request.actor)
                .await?;
            Err(ApiError::gateway(&error))
        }
    }
}

pub async fn void_invoice(
    State(state): State<Arc<AppState>>,
    Path(invoice_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<InvoiceActionRequest>,
) -> Result<Json<InvoiceRecord>, ApiError> {
    require_admin(&state, &headers)?;
    validate_actor(&request.actor)?;
    let invoice_id = parse_id(&invoice_id)?;
    let invoice = state.invoices.invoice(invoice_id).await?;
    let provider = invoice_provider(&state, &invoice).await?;
    provider
        .void(invoice_id)
        .await
        .map_err(|error| ApiError::gateway(&error))?;
    state
        .invoices
        .void(invoice_id, &request.actor)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

pub async fn red_letter_invoice(
    State(state): State<Arc<AppState>>,
    Path(invoice_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<InvoiceActionRequest>,
) -> Result<Json<InvoiceRecord>, ApiError> {
    require_admin(&state, &headers)?;
    validate_actor(&request.actor)?;
    let invoice_id = parse_id(&invoice_id)?;
    let invoice = state
        .invoices
        .begin_red_letter(invoice_id, &request.actor)
        .await?;
    let original_invoice_id = invoice.correction_of_invoice_id.ok_or_else(|| {
        ApiError::bad_request("red-letter operation requires a generated correction invoice")
    })?;
    let original = state.invoices.invoice(original_invoice_id).await?;
    let original_reference = original
        .provider_reference
        .as_deref()
        .ok_or_else(|| ApiError::bad_request("issued invoice has no provider reference"))?;
    let provider = invoice_provider(&state, &invoice).await?;
    let issue_request = issue_request(&state, &invoice)?;
    let outcome = provider
        .red_letter(&issue_request, original_reference)
        .await
        .map_err(|error| ApiError::gateway(&error))?;
    let artifact = outcome
        .artifact
        .as_ref()
        .map(|artifact| encrypt_artifact(&state, invoice_id, "credit_note", artifact))
        .transpose()?;
    state
        .invoices
        .complete_red_letter(&outcome, artifact.as_ref(), &request.actor)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

pub async fn download_invoice(
    State(state): State<Arc<AppState>>,
    Path(invoice_id): Path<String>,
    Query(query): Query<ArtifactQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    require_admin(&state, &headers)?;
    let invoice_id = parse_id(&invoice_id)?;
    let artifact_kind = query.artifact.as_deref().unwrap_or("invoice");
    if !matches!(artifact_kind, "invoice" | "credit_note") {
        return Err(ApiError::bad_request(
            "artifact must be invoice or credit_note",
        ));
    }
    let artifact = state.invoices.artifact(invoice_id, artifact_kind).await?;
    let content = state
        .invoice_cipher
        .decrypt(
            &artifact.ciphertext,
            &artifact.nonce,
            artifact.key_version,
            artifact_aad(artifact.invoice_id, artifact_kind).as_bytes(),
        )
        .map_err(|error| {
            tracing::error!(invoice_id = %invoice_id, error = %error, "invoice artifact decryption failed");
            ApiError::internal("invoice artifact could not be decrypted")
        })?;
    if Sha256::digest(&content).as_slice() != artifact.content_hash {
        return Err(ApiError::internal(
            "invoice artifact integrity verification failed",
        ));
    }
    let mut response = Response::new(Body::from(content));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        artifact
            .media_type
            .parse()
            .map_err(|_| ApiError::internal("stored invoice media type is invalid"))?,
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        format!("attachment; filename=\"{invoice_id}-{artifact_kind}.json\"")
            .parse()
            .map_err(|_| ApiError::internal("invoice filename is invalid"))?,
    );
    Ok(response)
}

pub async fn admin_gateways(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TenantQuery>,
    headers: HeaderMap,
) -> Result<Json<Vec<GatewayRecord>>, ApiError> {
    require_admin(&state, &headers)?;
    state
        .admin
        .gateways(query.tenant_id)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

pub async fn mutate_gateway(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<GatewayMutation>,
) -> Result<Json<GatewayRecord>, ApiError> {
    require_admin(&state, &headers)?;
    if request.enabled {
        let gateway_id = request
            .gateway_id
            .unwrap_or_else(matchplane_domain::PaymentGatewayId::new);
        let config = crate::gateways::GatewayConfig::from_parts(
            gateway_id,
            request.name.clone(),
            request.kind.as_str(),
            request.mode.as_str(),
            request.settings.clone(),
            request.credential_secret_ref.clone(),
        )
        .map_err(|error| ApiError::gateway(&error))?;
        ensure_gateway_environment(&state, &config)?;
        let digest = GatewayFactory::credential_digest(&config)
            .map_err(|error| ApiError::gateway(&error))?;
        let config = config.with_credential_digest(digest);
        build_gateway(&state, &config).await?;
    }
    state
        .admin
        .mutate_gateway(&request)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

pub async fn admin_routes(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TenantQuery>,
    headers: HeaderMap,
) -> Result<Json<Vec<RouteRecord>>, ApiError> {
    require_admin(&state, &headers)?;
    state
        .admin
        .routes(query.tenant_id)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

pub async fn mutate_route(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<RouteMutation>,
) -> Result<Json<RouteRecord>, ApiError> {
    require_admin(&state, &headers)?;
    state
        .admin
        .mutate_route(&request)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

pub async fn admin_invoice_providers(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TenantQuery>,
    headers: HeaderMap,
) -> Result<Json<Vec<InvoiceProviderRecord>>, ApiError> {
    require_admin(&state, &headers)?;
    state
        .admin
        .invoice_providers(query.tenant_id)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

pub async fn mutate_invoice_provider(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<InvoiceProviderMutation>,
) -> Result<Json<InvoiceProviderRecord>, ApiError> {
    require_admin(&state, &headers)?;
    state
        .admin
        .mutate_invoice_provider(&request)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

pub async fn invoice_setting(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TenantQuery>,
    headers: HeaderMap,
) -> Result<Json<InvoiceSetting>, ApiError> {
    require_admin(&state, &headers)?;
    state
        .admin
        .invoice_setting(query.tenant_id)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

pub async fn switch_invoice_mode(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<InvoiceModeSwitch>,
) -> Result<Json<InvoiceSetting>, ApiError> {
    require_admin(&state, &headers)?;
    state
        .admin
        .switch_invoice_mode(&request)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

pub async fn payment_setting(
    State(state): State<Arc<AppState>>,
    Query(query): Query<TenantQuery>,
    headers: HeaderMap,
) -> Result<Json<PaymentSetting>, ApiError> {
    require_admin(&state, &headers)?;
    state
        .admin
        .setting(query.tenant_id)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

pub async fn switch_payment_mode(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(request): Json<ModeSwitch>,
) -> Result<Json<PaymentSetting>, ApiError> {
    require_admin(&state, &headers)?;
    state
        .admin
        .switch_mode(&request)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

fn validate_payment_request(
    request: &AuthorizeRequest,
    callback_origin: Option<&Url>,
    environment: Environment,
) -> Result<(), ApiError> {
    if request.merchant_order_id.trim().is_empty() || request.merchant_order_id.len() > 200 {
        return Err(ApiError::bad_request(
            "merchant_order_id must contain 1..=200 bytes",
        ));
    }
    if request.idempotency_key.trim().is_empty() || request.idempotency_key.len() > 200 {
        return Err(ApiError::bad_request(
            "idempotency_key must contain 1..=200 bytes",
        ));
    }
    validate_callback_url(
        &request.notify_url,
        "notify_url",
        callback_origin,
        environment,
    )?;
    validate_callback_url(
        &request.return_url,
        "return_url",
        callback_origin,
        environment,
    )?;
    match (
        request.transaction_channel.as_str(),
        request.purpose.as_str(),
        request.offline_deal_id.is_some(),
        request.payer_party_id.is_some(),
    ) {
        ("online_platform", "vehicle_purchase" | "platform_commission", false, false)
        | ("offline_direct", "platform_commission", true, true) => Ok(()),
        _ => Err(ApiError::bad_request(
            "offline_direct accepts only a platform_commission payment linked to both offline_deal_id and payer_party_id",
        )),
    }
}

fn validate_callback_url(
    value: &str,
    field: &str,
    callback_origin: Option<&Url>,
    environment: Environment,
) -> Result<(), ApiError> {
    if value.trim().is_empty() || value.len() > 2_048 {
        return Err(ApiError::bad_request(format!(
            "{field} must contain 1..=2048 bytes"
        )));
    }
    let url = Url::parse(value)
        .map_err(|_| ApiError::bad_request(format!("{field} must be a valid URL")))?;
    if url.host_str().is_none()
        || url.username() != ""
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(ApiError::bad_request(format!(
            "{field} must contain a host and no credentials or fragment"
        )));
    }
    if environment == Environment::Production && url.scheme() != "https" {
        return Err(ApiError::bad_request(format!(
            "{field} must use HTTPS in production"
        )));
    }
    if let Some(origin) = callback_origin {
        let same_origin = url.scheme() == origin.scheme()
            && url.host_str() == origin.host_str()
            && url.port_or_known_default() == origin.port_or_known_default();
        if !same_origin {
            return Err(ApiError::bad_request(format!(
                "{field} must use the configured payment callback origin"
            )));
        }
    }
    Ok(())
}

fn validated_amount(money: &Money) -> Result<i128, ApiError> {
    let amount = money
        .exact_amount()
        .map_err(|error| ApiError::gateway(&error))?;
    Money::new(amount, money.currency.clone(), money.scale)
        .map_err(|error| ApiError::gateway(&error))?;
    if amount <= 0 {
        return Err(ApiError::bad_request("payment amount must be positive"));
    }
    Ok(amount)
}

impl ApiError {
    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal_error",
            message: message.into(),
        }
    }
}

fn require_admin(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());
    if state.admin_auth.verify_bearer(authorization) {
        Ok(())
    } else {
        Err(ApiError::unauthorized())
    }
}

async fn require_marketplace_party(
    state: &AppState,
    headers: &HeaderMap,
    tenant_id: matchplane_domain::TenantId,
    party_id: MarketplacePartyId,
) -> Result<(), ApiError> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .filter(|value| value.len() >= 64)
        .ok_or_else(ApiError::party_unauthorized)?;
    let token_hash = Sha256::digest(token.as_bytes());
    if state
        .store
        .marketplace_party_token_valid(tenant_id, party_id, token_hash.as_slice())
        .await?
    {
        Ok(())
    } else {
        Err(ApiError::party_unauthorized())
    }
}

fn validate_actor(actor: &str) -> Result<(), ApiError> {
    if actor.trim().is_empty() || actor.len() > 256 {
        Err(ApiError::bad_request("actor must contain 1..=256 bytes"))
    } else {
        Ok(())
    }
}

async fn invoice_provider(
    state: &AppState,
    invoice: &InvoiceRecord,
) -> Result<std::sync::Arc<dyn InvoiceProvider>, ApiError> {
    if invoice.provider_key == "local_test" && invoice.provider_mode == "test" {
        if state.environment == Environment::Production {
            return Err(ApiError::bad_request(
                "production cannot construct a test invoice provider",
            ));
        }
        return Ok(std::sync::Arc::new(TestInvoiceProvider));
    }
    if invoice.provider_mode != "production"
        || !matches!(invoice.provider_key.as_str(), "http_json" | "fapiao_http")
    {
        return Err(ApiError::gateway(&PaymentError::Unsupported {
            gateway: "invoice_provider",
            operation: "configured production invoice provider",
        }));
    }
    let config = state.invoices.provider_config(invoice).await?;
    let secret = crate::gateways::resolve_secret(&config.credential_secret_ref)
        .map_err(|error| ApiError::gateway(&error))?;
    let expected = config.credential_digest.as_deref().ok_or_else(|| {
        ApiError::gateway(&PaymentError::Credential(
            "invoice provider has no immutable credential digest".to_owned(),
        ))
    })?;
    let actual = Sha256::digest(secret.expose_secret());
    if expected != actual.as_slice() {
        return Err(ApiError::gateway(&PaymentError::Credential(
            "invoice provider credential material no longer matches its pinned digest".to_owned(),
        )));
    }
    let provider_key = config.provider_key;
    let settings = config.settings;
    let provider = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::task::spawn_blocking(move || {
            HttpInvoiceProvider::new(provider_key, &settings, secret)
        }),
    )
    .await
    .map_err(|_| ApiError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        code: "invoice_provider_resolution_timeout",
        message: "invoice provider endpoint resolution timed out; retry the operation".to_owned(),
    })?
    .map_err(|error| {
        ApiError::internal(format!(
            "invoice provider construction task failed: {error}"
        ))
    })?
    .map_err(|error| ApiError::gateway(&error))?;
    Ok(std::sync::Arc::new(provider))
}

fn ensure_gateway_environment(
    state: &AppState,
    config: &crate::gateways::GatewayConfig,
) -> Result<(), ApiError> {
    if state.environment == Environment::Production && config.mode == GatewayMode::Test {
        return Err(ApiError::bad_request(
            "production cannot construct a test payment gateway",
        ));
    }
    Ok(())
}

async fn build_gateway(
    state: &AppState,
    config: &crate::gateways::GatewayConfig,
) -> Result<std::sync::Arc<dyn matchplane_payments::PaymentGateway>, ApiError> {
    ensure_gateway_environment(state, config)?;
    let gateway_id = config.gateway_id;
    let config = config.clone();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::task::spawn_blocking(move || GatewayFactory::build(&config)),
    )
    .await
    .map_err(|_| ApiError {
        status: StatusCode::SERVICE_UNAVAILABLE,
        code: "gateway_resolution_timeout",
        message: "gateway endpoint resolution timed out; retry the operation".to_owned(),
    })?
    .map_err(|error| ApiError::internal(format!("gateway construction task failed: {error}")))?;
    result.map_err(|error| {
        tracing::error!(gateway_id = %gateway_id, error = %error, "gateway construction failed");
        ApiError::gateway(&error)
    })
}

fn issue_request(state: &AppState, invoice: &InvoiceRecord) -> Result<IssueInvoice, ApiError> {
    let billing_source_id = invoice
        .correction_of_invoice_id
        .unwrap_or(invoice.invoice_id);
    let bytes = state
        .invoice_cipher
        .decrypt(
            &invoice.billing_details_ciphertext,
            &invoice.billing_details_nonce,
            invoice.encryption_key_version,
            invoice_aad(invoice.tenant_id, billing_source_id).as_bytes(),
        )
        .map_err(|error| {
            tracing::error!(invoice_id = %invoice.invoice_id, error = %error, "invoice billing details decryption failed");
            ApiError::internal("invoice billing details could not be decrypted")
        })?;
    let recipient: InvoiceRecipient = serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::internal("invoice billing details are invalid"))?;
    Ok(IssueInvoice {
        invoice_id: invoice.invoice_id,
        tenant_id: invoice.tenant_id,
        kind: invoice_kind(&invoice.kind).map_err(|error| ApiError::gateway(&error))?,
        amount: Money::new(
            exact(&invoice.amount, "invoice amount")?,
            invoice.currency.clone(),
            u8::try_from(invoice.currency_scale)
                .map_err(|_| ApiError::internal("invoice currency scale is invalid"))?,
        )
        .map_err(|error| ApiError::gateway(&error))?,
        recipient,
        description: invoice.description.clone(),
    })
}

fn encrypt_artifact(
    state: &AppState,
    invoice_id: InvoiceId,
    kind: &str,
    artifact: &matchplane_payments::InvoiceArtifact,
) -> Result<EncryptedArtifact, ApiError> {
    let encrypted = state
        .invoice_cipher
        .encrypt(
            &artifact.content,
            artifact_aad(invoice_id, kind).as_bytes(),
        )
        .map_err(|error| {
            tracing::error!(invoice_id = %invoice_id, error = %error, "invoice artifact encryption failed");
            ApiError::internal("invoice artifact could not be protected")
        })?;
    Ok(EncryptedArtifact {
        media_type: artifact.media_type.clone(),
        ciphertext: encrypted.ciphertext,
        nonce: encrypted.nonce.to_vec(),
        key_version: encrypted.key_version,
        content_hash: Sha256::digest(&artifact.content).to_vec(),
    })
}

fn invoice_aad(tenant_id: matchplane_domain::TenantId, invoice_id: InvoiceId) -> String {
    format!("matchplane:invoice:{tenant_id}:{invoice_id}")
}

fn artifact_aad(invoice_id: InvoiceId, kind: &str) -> String {
    format!("matchplane:invoice-artifact:{invoice_id}:{kind}")
}

fn hash(value: &impl Serialize) -> Result<Vec<u8>, ApiError> {
    serde_json::to_vec(value)
        .map(|bytes| Sha256::digest(bytes).to_vec())
        .map_err(|_| ApiError::bad_request("request could not be canonicalized"))
}

fn parse_id<T>(value: &str) -> Result<T, ApiError>
where
    T: FromStr<Err = uuid::Error>,
{
    value
        .parse()
        .map_err(|_| ApiError::bad_request("identifier must be a valid UUID"))
}

fn parse_optional_id<T>(value: Option<&str>) -> Result<Option<T>, ApiError>
where
    T: FromStr<Err = uuid::Error>,
{
    value.map(parse_id).transpose()
}

fn exact(value: &str, field: &str) -> Result<i128, ApiError> {
    value
        .parse()
        .map_err(|_| ApiError::bad_request(format!("{field} must be an exact i128 integer")))
}

fn exact_positive(value: &str, field: &str) -> Result<i128, ApiError> {
    exact(value, field).and_then(|amount| {
        if amount > 0 {
            Ok(amount)
        } else {
            Err(ApiError::bad_request(format!("{field} must be positive")))
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn callback_urls_must_match_the_configured_production_origin() {
        let origin = Url::parse("https://payments.example.com").expect("origin is valid");

        assert!(
            validate_callback_url(
                "https://payments.example.com/return",
                "return_url",
                Some(&origin),
                Environment::Production,
            )
            .is_ok()
        );
        assert!(
            validate_callback_url(
                "https://evil.example/return",
                "return_url",
                Some(&origin),
                Environment::Production,
            )
            .is_err()
        );
        assert!(
            validate_callback_url(
                "http://payments.example.com/return",
                "return_url",
                Some(&origin),
                Environment::Production,
            )
            .is_err()
        );
    }
}

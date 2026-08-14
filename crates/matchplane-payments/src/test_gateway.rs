use async_trait::async_trait;
use matchplane_domain::PaymentId;

use crate::{
    AuthorizePayment, CapturePayment, GatewayDescriptor, GatewayKind, GatewayMode, GatewayStatus,
    PaymentError, PaymentGateway, PaymentOutcome, PaymentStatus, QueryPayment, RefundOutcome,
    RefundPayment, RefundStatus, VoidPayment,
};

/// Stateless deterministic sandbox used only when the administrator selects test mode.
///
/// Durable state and idempotency live in the payment service database, so sandbox operations still
/// work after a process restart.
#[derive(Debug)]
pub struct TestGateway {
    descriptor: GatewayDescriptor,
}

impl TestGateway {
    /// Creates a deterministic sandbox gateway.
    #[must_use]
    pub fn new(descriptor: GatewayDescriptor) -> Self {
        debug_assert_eq!(descriptor.kind, GatewayKind::Test);
        debug_assert_eq!(descriptor.mode, GatewayMode::Test);
        Self { descriptor }
    }

    fn reference(payment_id: PaymentId) -> String {
        format!("test-{payment_id}")
    }

    fn outcome(payment_id: PaymentId, status: PaymentStatus) -> PaymentOutcome {
        PaymentOutcome {
            payment_id,
            provider_reference: Self::reference(payment_id),
            status,
            redirect_url: None,
            provider_status: format!("{status:?}").to_ascii_lowercase(),
        }
    }

    fn validate_reference(
        payment_id: PaymentId,
        provider_reference: &str,
    ) -> Result<(), PaymentError> {
        if provider_reference == Self::reference(payment_id) {
            Ok(())
        } else {
            Err(PaymentError::Invalid(
                "sandbox provider reference does not match payment".to_owned(),
            ))
        }
    }
}

#[async_trait]
impl PaymentGateway for TestGateway {
    fn descriptor(&self) -> &GatewayDescriptor {
        &self.descriptor
    }

    async fn authorize(&self, request: &AuthorizePayment) -> Result<PaymentOutcome, PaymentError> {
        if request.amount.exact_amount()? <= 0 {
            return Err(PaymentError::Invalid(
                "authorization amount must be positive".to_owned(),
            ));
        }
        Ok(Self::outcome(request.payment_id, PaymentStatus::Authorized))
    }

    async fn capture(&self, request: &CapturePayment) -> Result<PaymentOutcome, PaymentError> {
        Self::validate_reference(request.payment_id, &request.provider_reference)?;
        let capture = request.amount.exact_amount()?;
        if request.amount.currency != request.authorized_amount.currency
            || request.amount.scale != request.authorized_amount.scale
            || capture <= 0
            || capture > request.authorized_amount.exact_amount()?
        {
            return Err(PaymentError::Invalid(
                "capture exceeds the authorized amount or changes currency".to_owned(),
            ));
        }
        Ok(Self::outcome(request.payment_id, PaymentStatus::Captured))
    }

    async fn void(&self, request: &VoidPayment) -> Result<PaymentOutcome, PaymentError> {
        Self::validate_reference(request.payment_id, &request.provider_reference)?;
        Ok(Self::outcome(request.payment_id, PaymentStatus::Voided))
    }

    async fn refund(&self, request: &RefundPayment) -> Result<RefundOutcome, PaymentError> {
        Self::validate_reference(request.payment_id, &request.provider_reference)?;
        let amount = request.amount.exact_amount()?;
        if request.amount.currency != request.captured_amount.currency
            || request.amount.scale != request.captured_amount.scale
            || amount <= 0
            || amount > request.captured_amount.exact_amount()?
        {
            return Err(PaymentError::Invalid(
                "refund exceeds captured amount or changes currency".to_owned(),
            ));
        }
        Ok(RefundOutcome {
            refund_id: request.refund_id,
            provider_reference: format!("test-refund-{}", request.refund_id),
            status: RefundStatus::Succeeded,
            provider_status: "succeeded".to_owned(),
        })
    }

    async fn query(&self, request: &QueryPayment) -> Result<PaymentOutcome, PaymentError> {
        if let Some(reference) = &request.provider_reference {
            Self::validate_reference(request.payment_id, reference)?;
        }
        Ok(Self::outcome(request.payment_id, PaymentStatus::Authorized))
    }

    async fn health(&self) -> Result<GatewayStatus, PaymentError> {
        Ok(GatewayStatus {
            healthy: true,
            message: "deterministic sandbox ready".to_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use matchplane_domain::{PaymentGatewayId, RefundId, TenantId};
    use time::OffsetDateTime;

    use super::*;
    use crate::{GatewayCapabilities, Money, PaymentMethod};

    fn gateway() -> TestGateway {
        TestGateway::new(GatewayDescriptor {
            gateway_id: PaymentGatewayId::new(),
            name: "test".to_owned(),
            kind: GatewayKind::Test,
            mode: GatewayMode::Test,
            capabilities: GatewayCapabilities {
                manual_capture: true,
                void: true,
                refund: true,
                partial_capture: true,
                partial_refund: true,
                status_query: true,
            },
        })
    }

    fn authorize(payment_id: PaymentId) -> AuthorizePayment {
        AuthorizePayment {
            payment_id,
            tenant_id: TenantId::new(),
            merchant_order_id: "order-1".to_owned(),
            idempotency_key: "authorize-1".to_owned(),
            amount: Money::new(10_000, "CNY", 2).expect("test money is valid"),
            method: PaymentMethod::Card,
            payment_token: None,
            notify_url: "https://example.invalid/notify".to_owned(),
            return_url: "https://example.invalid/return".to_owned(),
            description: "vehicle".to_owned(),
            requested_at: OffsetDateTime::now_utc(),
        }
    }

    #[tokio::test]
    async fn test_gateway_should_authorize_capture_and_partially_refund() {
        let gateway = gateway();
        let payment_id = PaymentId::new();
        let authorization = gateway
            .authorize(&authorize(payment_id))
            .await
            .expect("authorization should succeed");
        assert_eq!(authorization.status, PaymentStatus::Authorized);

        let capture = gateway
            .capture(&CapturePayment {
                payment_id,
                provider_reference: authorization.provider_reference.clone(),
                amount: Money::new(9_000, "CNY", 2).expect("test money is valid"),
                authorized_amount: Money::new(10_000, "CNY", 2).expect("test money is valid"),
                idempotency_key: "capture-1".to_owned(),
            })
            .await
            .expect("capture should succeed");
        assert_eq!(capture.status, PaymentStatus::Captured);

        let refund = gateway
            .refund(&RefundPayment {
                refund_id: RefundId::new(),
                payment_id,
                provider_reference: authorization.provider_reference,
                amount: Money::new(1_000, "CNY", 2).expect("test money is valid"),
                captured_amount: Money::new(9_000, "CNY", 2).expect("test money is valid"),
                idempotency_key: "refund-1".to_owned(),
                reason: "buyer cancellation".to_owned(),
                notify_url: Some("https://example.invalid/refunds".to_owned()),
            })
            .await
            .expect("refund should succeed");
        assert_eq!(refund.status, RefundStatus::Succeeded);
    }
}

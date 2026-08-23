use matchplane_domain::{
    AccountId, CorrelationId, DomainId, FederationNodeId, MarketId, OrderId, OrderIntent,
    OrderSide, Price, Quantity, TenantId,
};
use matchplane_storage::{SubmitOrder, SubmitOrderOutcome};
use time::OffsetDateTime;

use crate::{ApplicationError, OrderWriter};

/// HTTP-agnostic order placement command.
#[derive(Debug, Clone)]
pub struct PlaceOrderCommand {
    /// Optional caller-supplied order identifier.
    pub order_id: Option<OrderId>,
    /// Tenant scope.
    pub tenant_id: TenantId,
    /// Domain scope.
    pub domain_id: DomainId,
    /// Market scope.
    pub market_id: MarketId,
    /// Order side.
    pub side: OrderSide,
    /// Limit price as an exact integer string.
    pub price: String,
    /// Quantity as an exact integer string.
    pub quantity: String,
    /// Idempotency key.
    pub idempotency_key: String,
    /// Reservation account identifier.
    pub reservation_account_id: AccountId,
    /// Settlement account identifier.
    pub settlement_account_id: AccountId,
    /// Submission timestamp.
    pub submitted_at: Option<OffsetDateTime>,
    /// Optional expiry timestamp.
    pub expires_at: Option<OffsetDateTime>,
}

/// Result of a successful order placement.
#[derive(Debug, Clone)]
pub struct PlaceOrderOutcome {
    /// Persisted command outcome.
    pub outcome: SubmitOrderOutcome,
    /// Whether the request duplicated an earlier idempotent submission.
    pub duplicate: bool,
}

/// Order-book application service.
#[derive(Debug, Clone)]
pub struct OrderService<W> {
    writer: W,
    node_id: FederationNodeId,
}

impl<W> OrderService<W>
where
    W: OrderWriter,
{
    /// Creates an order service bound to a persistence port.
    pub fn new(writer: W, node_id: FederationNodeId) -> Self {
        Self { writer, node_id }
    }

    /// Validates and persists a new order command.
    pub async fn place_order(
        &self,
        command: PlaceOrderCommand,
    ) -> Result<PlaceOrderOutcome, ApplicationError> {
        let order_id = command.order_id.unwrap_or_default();
        let price = parse_price(&command.price)?;
        let quantity = parse_quantity(&command.quantity)?;
        let reservation_amount = reservation_amount(command.side, price, quantity)?;
        let submitted_at = command
            .submitted_at
            .unwrap_or_else(OffsetDateTime::now_utc);
        if command
            .expires_at
            .is_some_and(|expiry| expiry <= submitted_at)
        {
            return Err(ApplicationError::validation(
                "expires_at must be later than submitted_at",
            ));
        }

        let request = SubmitOrder {
            intent: OrderIntent {
                order_id,
                tenant_id: command.tenant_id,
                domain_id: command.domain_id,
                market_id: command.market_id,
                side: command.side,
                price,
                quantity,
                submitted_at,
                expires_at: command.expires_at,
            },
            idempotency_key: command.idempotency_key,
            reservation_account_id: command.reservation_account_id,
            settlement_account_id: command.settlement_account_id,
            reservation_amount,
            source_node_id: self.node_id,
            correlation_id: CorrelationId::new(),
        };
        let outcome = self.writer.submit_order(&request).await?;
        Ok(PlaceOrderOutcome {
            duplicate: outcome.duplicate,
            outcome,
        })
    }
}

fn parse_price(value: &str) -> Result<Price, ApplicationError> {
    let raw = value
        .parse()
        .map_err(|_| ApplicationError::validation("price must be a base-10 integer string"))?;
    Price::new(raw).map_err(|error| ApplicationError::validation(error.to_string()))
}

fn parse_quantity(value: &str) -> Result<Quantity, ApplicationError> {
    let raw = value
        .parse()
        .map_err(|_| ApplicationError::validation("quantity must be a base-10 integer string"))?;
    Quantity::new(raw).map_err(|error| ApplicationError::validation(error.to_string()))
}

fn reservation_amount(
    side: OrderSide,
    price: Price,
    quantity: Quantity,
) -> Result<Quantity, ApplicationError> {
    match side {
        OrderSide::Buy => {
            let gross = price
                .checked_mul(quantity)
                .map_err(|error| ApplicationError::validation(error.to_string()))?;
            Quantity::new(gross.value())
                .map_err(|error| ApplicationError::validation(error.to_string()))
        }
        OrderSide::Sell => Ok(quantity),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use matchplane_domain::{EventId, OrderId, OrderSide, TenantId};
    use matchplane_storage::{StorageError, StoredOrder, SubmitOrder, SubmitOrderOutcome};
    use time::OffsetDateTime;

    struct StubWriter;

    #[async_trait]
    impl OrderWriter for StubWriter {
        async fn submit_order(
            &self,
            request: &SubmitOrder,
        ) -> Result<SubmitOrderOutcome, StorageError> {
            Ok(SubmitOrderOutcome {
                order_id: request.intent.order_id,
                command_id: EventId::new(),
                shard_sequence: 1,
                duplicate: false,
            })
        }

        async fn order(&self, _order_id: OrderId) -> Result<StoredOrder, StorageError> {
            Err(StorageError::NotFound("order"))
        }
    }

    #[tokio::test]
    async fn place_order_rejects_expiry_before_submission() {
        let service = OrderService::new(StubWriter, FederationNodeId::new());
        let submitted_at = OffsetDateTime::now_utc();
        let command = PlaceOrderCommand {
            order_id: None,
            tenant_id: TenantId::new(),
            domain_id: matchplane_domain::DomainId::new(),
            market_id: MarketId::new(),
            side: OrderSide::Buy,
            price: "100".into(),
            quantity: "1".into(),
            idempotency_key: "idem-1".into(),
            reservation_account_id: AccountId::new(),
            settlement_account_id: AccountId::new(),
            submitted_at: Some(submitted_at),
            expires_at: Some(submitted_at),
        };

        let error = service
            .place_order(command)
            .await
            .expect_err("expiry must be rejected");
        assert!(matches!(error, ApplicationError::Validation(_)));
    }
}

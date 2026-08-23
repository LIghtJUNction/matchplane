use async_trait::async_trait;
use matchplane_domain::OrderId;
use matchplane_storage::{PgStore, StorageError, StoredOrder, SubmitOrder, SubmitOrderOutcome};

/// Persistence port for order-book commands.
#[async_trait]
pub trait OrderWriter: Send + Sync {
    /// Persists a new order command.
    async fn submit_order(
        &self,
        request: &SubmitOrder,
    ) -> Result<SubmitOrderOutcome, StorageError>;

    /// Loads a stored order by identifier.
    async fn order(&self, order_id: OrderId) -> Result<StoredOrder, StorageError>;
}

#[async_trait]
impl OrderWriter for PgStore {
    async fn submit_order(
        &self,
        request: &SubmitOrder,
    ) -> Result<SubmitOrderOutcome, StorageError> {
        self.submit_order(request).await
    }

    async fn order(&self, order_id: OrderId) -> Result<StoredOrder, StorageError> {
        self.order(order_id).await
    }
}

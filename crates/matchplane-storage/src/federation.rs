use matchplane_domain::{FederationNodeId, ReservationId};
use sqlx::{Postgres, Row, Transaction, postgres::PgRow};
use uuid::Uuid;

use crate::{FederationReservation, FederationTransition, PgStore, ReserveFederated, StorageError};

const RESERVED: &str = "reserved";
const CONFIRMED: &str = "confirmed";
const ABORTED: &str = "aborted";
const EXPIRED: &str = "expired";

impl PgStore {
    /// Verifies or creates the local federation node registration used by durable commands.
    ///
    /// Development and test deployments may register their generated node id automatically.
    /// Production deployments must pre-register the node so its operator-managed certificate and
    /// signing metadata cannot be replaced implicitly during service startup.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError::NotFound`] when production has no active registration, or a
    /// PostgreSQL error when the registration cannot be read or written.
    pub async fn ensure_local_node(
        &self,
        node_id: FederationNodeId,
        grpc_endpoint: &str,
        allow_auto_register: bool,
    ) -> Result<(), StorageError> {
        if grpc_endpoint.trim().is_empty() {
            return Err(StorageError::InvalidData(
                "local federation gRPC endpoint cannot be empty".to_owned(),
            ));
        }

        if allow_auto_register {
            let node_name = format!("matchplane-local-{node_id}");
            let result = sqlx::query(
                "INSERT INTO federation_nodes \
                 (id, name, grpc_endpoint, signing_key, protocol_major, protocol_minor) \
                 VALUES ($1, $2, $3, 'local-test-node', 1, 0) \
                 ON CONFLICT (id) DO UPDATE SET \
                   grpc_endpoint = EXCLUDED.grpc_endpoint, \
                   last_seen_at = clock_timestamp(), \
                   updated_at = clock_timestamp() \
                 WHERE federation_nodes.status = 'active'",
            )
            .bind(node_id.into_uuid())
            .bind(node_name)
            .bind(grpc_endpoint)
            .execute(self.pool())
            .await?;
            if result.rows_affected() != 1 {
                return Err(StorageError::Conflict(
                    "local federation node is disabled".to_owned(),
                ));
            }
            return Ok(());
        }

        let registered =
            sqlx::query("SELECT 1 FROM federation_nodes WHERE id = $1 AND status = 'active'")
                .bind(node_id.into_uuid())
                .fetch_optional(self.pool())
                .await?
                .is_some();
        if !registered {
            return Err(StorageError::NotFound("active local federation node"));
        }
        Ok(())
    }

    /// Checks that a federation node is active and, when supplied, bound to the presented mTLS
    /// certificate SHA-256 fingerprint.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError::NotFound`] when the node identity is inactive or the certificate
    /// fingerprint does not match its allow-list record.
    pub async fn authenticate_federation_node(
        &self,
        node_id: FederationNodeId,
        certificate_fingerprint: Option<&str>,
    ) -> Result<(), StorageError> {
        let result = sqlx::query(
            "UPDATE federation_nodes SET last_seen_at = clock_timestamp(), version = version + 1 \
             WHERE id = $1 AND status = 'active' \
               AND ($2::text IS NULL OR certificate_fingerprint = $2)",
        )
        .bind(node_id.into_uuid())
        .bind(certificate_fingerprint)
        .execute(self.pool())
        .await?;
        if result.rows_affected() != 1 {
            return Err(StorageError::NotFound("authenticated federation node"));
        }
        Ok(())
    }

    /// Authenticates an active federation node and reports its configured protocol version.
    ///
    /// Transport authentication is performed by the federation service's mutual-TLS listener;
    /// this database check is the final node allow-list decision.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError::NotFound`] when the node is not active, or [`StorageError`] when
    /// PostgreSQL cannot update its liveness timestamp.
    pub async fn federation_node_protocol(
        &self,
        node_id: FederationNodeId,
        nonce: &str,
        certificate_fingerprint: Option<&str>,
    ) -> Result<(u32, u32), StorageError> {
        validate_nonce(nonce)?;
        let mut transaction = self.pool().begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
            .execute(&mut *transaction)
            .await?;
        let row = sqlx::query(
            "UPDATE federation_nodes SET last_seen_at = clock_timestamp(), version = version + 1 \
             WHERE id = $1 AND status = 'active' \
               AND ($2::text IS NULL OR certificate_fingerprint = $2) \
             RETURNING protocol_major, protocol_minor",
        )
        .bind(node_id.into_uuid())
        .bind(certificate_fingerprint)
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(StorageError::NotFound("active federation node"))?;
        let inserted = sqlx::query(
            "INSERT INTO federation_replay_nonces (source_node_id, nonce, operation) \
             VALUES ($1, $2, 'negotiate') ON CONFLICT DO NOTHING",
        )
        .bind(node_id.into_uuid())
        .bind(nonce)
        .execute(&mut *transaction)
        .await?
        .rows_affected();
        if inserted != 1 {
            return Err(StorageError::ReplayDetected);
        }
        let major: i32 = row.try_get("protocol_major")?;
        let minor: i32 = row.try_get("protocol_minor")?;
        let protocol = (
            u32::try_from(major).map_err(|_| {
                StorageError::InvalidData("federation protocol major is negative".to_owned())
            })?,
            u32::try_from(minor).map_err(|_| {
                StorageError::InvalidData("federation protocol minor is negative".to_owned())
            })?,
        );
        transaction.commit().await?;
        Ok(protocol)
    }

    /// Atomically holds source-owned order quantity for a cross-node Saga.
    ///
    /// The source node remains authoritative: PostgreSQL serializes the order lock, checks the
    /// caller's fencing epoch, and records the hold before any success response is returned.
    /// Identical retries return the original reservation; changed payloads are rejected.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] for malformed input, stale fencing, an idempotency conflict, an
    /// inactive peer, unavailable quantity, or a failed database transaction.
    pub async fn reserve_federated(
        &self,
        request: &ReserveFederated,
    ) -> Result<FederationReservation, StorageError> {
        validate_reserve(request)?;
        let mut transaction = self.pool().begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
            .execute(&mut *transaction)
            .await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(format!(
                "federation:{}:{}",
                request.source_node_id, request.idempotency_key
            ))
            .execute(&mut *transaction)
            .await?;

        if let Some(row) = existing_reservation(&mut transaction, request).await? {
            let stored_hash: Vec<u8> = row.try_get("request_hash")?;
            if stored_hash.as_slice() != request.request_hash.into_bytes() {
                return Err(StorageError::IdempotencyConflict);
            }
            let reservation = reservation_from_row(&row)?;
            transaction.commit().await?;
            return Ok(reservation);
        }

        ensure_future_reservation_expiry(&mut transaction, request.expires_at).await?;
        lock_federation_node(&mut transaction, request).await?;
        lock_order_capacity(&mut transaction, request).await?;
        let reservation_id = ReservationId::new();
        let row = sqlx::query(
            "INSERT INTO federation_saga_reservations \
             (id, source_node_id, tenant_id, domain_id, market_id, order_id, quantity, status, \
              idempotency_key, request_hash, fencing_token, nonce, expires_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7::numeric, 'reserved', $8, $9, $10, $11, $12) \
             RETURNING id, status, version, fencing_token, expires_at",
        )
        .bind(reservation_id.into_uuid())
        .bind(request.source_node_id.into_uuid())
        .bind(request.tenant_id.into_uuid())
        .bind(request.domain_id.into_uuid())
        .bind(request.market_id.into_uuid())
        .bind(request.order_id.into_uuid())
        .bind(request.quantity.to_string())
        .bind(&request.idempotency_key)
        .bind(request.request_hash.into_bytes().to_vec())
        .bind(request.fencing_token)
        .bind(&request.nonce)
        .bind(request.expires_at)
        .fetch_one(&mut *transaction)
        .await?;
        let reservation = reservation_from_row(&row)?;
        transaction.commit().await?;
        Ok(reservation)
    }

    /// Confirms a federation reservation using an idempotent compare-and-swap transition.
    ///
    /// Confirmed quantity remains protected from the local matcher. A later authoritative
    /// settlement command is responsible for turning that protected capacity into trade facts.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] for bad credentials, stale versions, invalid transitions, or
    /// database failures.
    pub async fn confirm_federated(
        &self,
        request: &FederationTransition,
    ) -> Result<FederationReservation, StorageError> {
        self.transition_federated(request, CONFIRMED).await
    }

    /// Aborts a federation reservation and releases its quantity back to local matching.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] for bad credentials, stale versions, invalid transitions, or
    /// database failures.
    pub async fn abort_federated(
        &self,
        request: &FederationTransition,
    ) -> Result<FederationReservation, StorageError> {
        self.transition_federated(request, ABORTED).await
    }

    async fn transition_federated(
        &self,
        request: &FederationTransition,
        target: &'static str,
    ) -> Result<FederationReservation, StorageError> {
        validate_transition(request)?;
        let mut transaction = self.pool().begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
            .execute(&mut *transaction)
            .await?;
        let row = sqlx::query(
            "SELECT id, source_node_id, order_id, quantity::text AS quantity, status, \
                    idempotency_key, version, fencing_token, expires_at, \
                    expires_at <= clock_timestamp() AS expired \
             FROM federation_saga_reservations \
             WHERE id = $1 FOR UPDATE",
        )
        .bind(request.reservation_id.into_uuid())
        .fetch_optional(&mut *transaction)
        .await?
        .ok_or(StorageError::NotFound("federation reservation"))?;
        let status: String = row.try_get("status")?;
        let idempotency_key: String = row.try_get("idempotency_key")?;
        let fencing_token: i64 = row.try_get("fencing_token")?;
        let version: i64 = row.try_get("version")?;
        let source_node_id: Uuid = row.try_get("source_node_id")?;
        if source_node_id != request.source_node_id.into_uuid() {
            return Err(StorageError::NotFound("federation reservation"));
        }
        if idempotency_key != request.idempotency_key {
            return Err(StorageError::IdempotencyConflict);
        }
        if fencing_token != request.fencing_token {
            return Err(StorageError::StaleFencingToken);
        }
        register_transition_nonce(&mut transaction, request, target).await?;
        if status == target {
            let reservation = reservation_from_row(&row)?;
            transaction.commit().await?;
            return Ok(reservation);
        }
        if status != RESERVED {
            return Err(StorageError::InvalidReservationTransition {
                from: status,
                to: target,
            });
        }

        let order_id: Uuid = row.try_get("order_id")?;
        let quantity: String = row.try_get("quantity")?;
        let expired: bool = row.try_get("expired")?;
        if expired {
            release_order_capacity(&mut transaction, order_id, &quantity).await?;
            let expired = update_reservation_status(
                &mut transaction,
                request.reservation_id,
                version,
                EXPIRED,
            )
            .await?;
            transaction.commit().await?;
            return Ok(expired);
        }
        if version != request.expected_version {
            return Err(StorageError::ReservationVersionConflict);
        }
        if target == ABORTED {
            release_order_capacity(&mut transaction, order_id, &quantity).await?;
        }
        let updated = update_reservation_status(
            &mut transaction,
            request.reservation_id,
            request.expected_version,
            target,
        )
        .await?;
        transaction.commit().await?;
        Ok(updated)
    }
}

fn validate_reserve(request: &ReserveFederated) -> Result<(), StorageError> {
    if request.idempotency_key.is_empty() || request.idempotency_key.len() > 200 {
        return Err(StorageError::InvalidData(
            "federation idempotency key length must be in 1..=200".to_owned(),
        ));
    }
    if !(16..=256).contains(&request.nonce.len()) {
        return Err(StorageError::InvalidData(
            "federation nonce length must be in 16..=256".to_owned(),
        ));
    }
    if request.fencing_token <= 0 {
        return Err(StorageError::InvalidData(
            "federation fencing token must be positive".to_owned(),
        ));
    }
    Ok(())
}

async fn ensure_future_reservation_expiry(
    transaction: &mut Transaction<'_, Postgres>,
    expires_at: time::OffsetDateTime,
) -> Result<(), StorageError> {
    let expires_in_future =
        sqlx::query_scalar::<_, bool>("SELECT $1::timestamptz > clock_timestamp()")
            .bind(expires_at)
            .fetch_one(&mut **transaction)
            .await?;
    if !expires_in_future {
        return Err(StorageError::InvalidData(
            "federation reservation must expire in the future".to_owned(),
        ));
    }
    Ok(())
}

fn validate_transition(request: &FederationTransition) -> Result<(), StorageError> {
    if request.idempotency_key.is_empty() || request.idempotency_key.len() > 200 {
        return Err(StorageError::InvalidData(
            "federation idempotency key length must be in 1..=200".to_owned(),
        ));
    }
    if request.expected_version <= 0 {
        return Err(StorageError::InvalidData(
            "federation reservation version must be positive".to_owned(),
        ));
    }
    if request.fencing_token <= 0 {
        return Err(StorageError::InvalidData(
            "federation fencing token must be positive".to_owned(),
        ));
    }
    validate_nonce(&request.nonce)?;
    Ok(())
}

fn validate_nonce(nonce: &str) -> Result<(), StorageError> {
    if !(16..=256).contains(&nonce.len()) {
        return Err(StorageError::InvalidData(
            "federation nonce length must be in 16..=256".to_owned(),
        ));
    }
    Ok(())
}

async fn existing_reservation(
    transaction: &mut Transaction<'_, Postgres>,
    request: &ReserveFederated,
) -> Result<Option<PgRow>, StorageError> {
    Ok(sqlx::query(
        "SELECT id, status, version, fencing_token, expires_at, request_hash \
         FROM federation_saga_reservations \
         WHERE source_node_id = $1 AND idempotency_key = $2 FOR UPDATE",
    )
    .bind(request.source_node_id.into_uuid())
    .bind(&request.idempotency_key)
    .fetch_optional(&mut **transaction)
    .await?)
}

async fn lock_federation_node(
    transaction: &mut Transaction<'_, Postgres>,
    request: &ReserveFederated,
) -> Result<(), StorageError> {
    let row =
        sqlx::query("SELECT status, fencing_token FROM federation_nodes WHERE id = $1 FOR UPDATE")
            .bind(request.source_node_id.into_uuid())
            .fetch_optional(&mut **transaction)
            .await?
            .ok_or(StorageError::NotFound("federation node"))?;
    let status: String = row.try_get("status")?;
    let fencing_token: i64 = row.try_get("fencing_token")?;
    if status != "active" {
        return Err(StorageError::NotFound("active federation node"));
    }
    if request.fencing_token < fencing_token {
        return Err(StorageError::StaleFencingToken);
    }
    sqlx::query(
        "UPDATE federation_nodes SET fencing_token = GREATEST(fencing_token, $2), \
                last_seen_at = clock_timestamp(), version = version + 1 WHERE id = $1",
    )
    .bind(request.source_node_id.into_uuid())
    .bind(request.fencing_token)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

async fn lock_order_capacity(
    transaction: &mut Transaction<'_, Postgres>,
    request: &ReserveFederated,
) -> Result<(), StorageError> {
    let result = sqlx::query(
        "UPDATE orders SET federated_reserved_quantity = federated_reserved_quantity + $5::numeric, \
                version = version + 1 \
         WHERE id = $1 AND tenant_id = $2 AND domain_id = $3 AND market_id = $4 \
           AND status IN ('open', 'partially_filled') \
           AND remaining_quantity - federated_reserved_quantity >= $5::numeric",
    )
    .bind(request.order_id.into_uuid())
    .bind(request.tenant_id.into_uuid())
    .bind(request.domain_id.into_uuid())
    .bind(request.market_id.into_uuid())
    .bind(request.quantity.to_string())
    .execute(&mut **transaction)
    .await?;
    if result.rows_affected() != 1 {
        return Err(StorageError::ReservationUnavailable);
    }
    Ok(())
}

async fn release_order_capacity(
    transaction: &mut Transaction<'_, Postgres>,
    order_id: Uuid,
    quantity: &str,
) -> Result<(), StorageError> {
    let result = sqlx::query(
        "UPDATE orders SET federated_reserved_quantity = federated_reserved_quantity - $2::numeric, \
                version = version + 1 \
         WHERE id = $1 AND federated_reserved_quantity >= $2::numeric",
    )
    .bind(order_id)
    .bind(quantity)
    .execute(&mut **transaction)
    .await?;
    if result.rows_affected() != 1 {
        return Err(StorageError::InvalidData(
            "federation reservation exceeds the order's protected quantity".to_owned(),
        ));
    }
    Ok(())
}

async fn update_reservation_status(
    transaction: &mut Transaction<'_, Postgres>,
    reservation_id: ReservationId,
    expected_version: i64,
    status: &'static str,
) -> Result<FederationReservation, StorageError> {
    let row = sqlx::query(
        "UPDATE federation_saga_reservations SET status = $3, version = version + 1 \
         WHERE id = $1 AND version = $2 AND status = 'reserved' \
         RETURNING id, status, version, fencing_token, expires_at",
    )
    .bind(reservation_id.into_uuid())
    .bind(expected_version)
    .bind(status)
    .fetch_optional(&mut **transaction)
    .await?
    .ok_or(StorageError::ReservationVersionConflict)?;
    reservation_from_row(&row)
}

async fn register_transition_nonce(
    transaction: &mut Transaction<'_, Postgres>,
    request: &FederationTransition,
    operation: &'static str,
) -> Result<(), StorageError> {
    let inserted = sqlx::query(
        "INSERT INTO federation_replay_nonces \
         (source_node_id, nonce, operation, reservation_id) VALUES ($1, $2, $3, $4) \
         ON CONFLICT DO NOTHING",
    )
    .bind(request.source_node_id.into_uuid())
    .bind(&request.nonce)
    .bind(operation)
    .bind(request.reservation_id.into_uuid())
    .execute(&mut **transaction)
    .await?
    .rows_affected();
    if inserted == 1 {
        return Ok(());
    }
    let row = sqlx::query(
        "SELECT operation, reservation_id FROM federation_replay_nonces \
         WHERE source_node_id = $1 AND nonce = $2",
    )
    .bind(request.source_node_id.into_uuid())
    .bind(&request.nonce)
    .fetch_one(&mut **transaction)
    .await?;
    let stored_operation: String = row.try_get("operation")?;
    let stored_reservation_id: Option<Uuid> = row.try_get("reservation_id")?;
    if stored_operation != operation
        || stored_reservation_id != Some(request.reservation_id.into_uuid())
    {
        return Err(StorageError::ReplayDetected);
    }
    Ok(())
}

fn reservation_from_row(row: &PgRow) -> Result<FederationReservation, StorageError> {
    Ok(FederationReservation {
        reservation_id: ReservationId::from_uuid(row.try_get("id")?),
        status: row.try_get("status")?,
        version: row.try_get("version")?,
        fencing_token: row.try_get("fencing_token")?,
        expires_at: row.try_get("expires_at")?,
    })
}

/// Releases expired, unconfirmed federation holds before a market's next authoritative commit.
pub(crate) async fn expire_federated_reservations(
    transaction: &mut Transaction<'_, Postgres>,
    market_id: Uuid,
) -> Result<(), StorageError> {
    let rows = sqlx::query(
        "SELECT id, order_id, quantity::text AS quantity \
         FROM federation_saga_reservations \
         WHERE market_id = $1 AND status = 'reserved' AND expires_at <= clock_timestamp() \
         FOR UPDATE",
    )
    .bind(market_id)
    .fetch_all(&mut **transaction)
    .await?;
    for row in rows {
        let reservation_id: Uuid = row.try_get("id")?;
        let order_id: Uuid = row.try_get("order_id")?;
        let quantity: String = row.try_get("quantity")?;
        release_order_capacity(transaction, order_id, &quantity).await?;
        sqlx::query(
            "UPDATE federation_saga_reservations SET status = 'expired', version = version + 1 \
             WHERE id = $1 AND status = 'reserved'",
        )
        .bind(reservation_id)
        .execute(&mut **transaction)
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use matchplane_domain::{DomainId, MarketId, OrderId, PayloadHash, Quantity, TenantId};
    use time::{Duration, OffsetDateTime};

    fn reserve() -> ReserveFederated {
        ReserveFederated {
            source_node_id: FederationNodeId::new(),
            tenant_id: TenantId::new(),
            domain_id: DomainId::new(),
            market_id: MarketId::new(),
            order_id: OrderId::new(),
            quantity: match Quantity::new(1) {
                Ok(quantity) => quantity,
                Err(error) => panic!("positive test quantity was rejected: {error}"),
            },
            idempotency_key: "federation-test".to_owned(),
            request_hash: PayloadHash::from_bytes(b"request"),
            fencing_token: 1,
            nonce: "0123456789abcdef".to_owned(),
            expires_at: OffsetDateTime::now_utc() + Duration::minutes(1),
        }
    }

    #[test]
    fn validate_reserve_should_reject_short_nonce() {
        let mut request = reserve();
        request.nonce = "short".to_owned();

        let result = validate_reserve(&request);

        assert!(matches!(result, Err(StorageError::InvalidData(_))));
    }

    #[test]
    fn validate_reserve_should_accept_bounded_request() {
        assert!(validate_reserve(&reserve()).is_ok());
    }

    #[test]
    fn validate_reserve_should_defer_expiry_to_postgres() {
        let mut request = reserve();
        request.expires_at = OffsetDateTime::UNIX_EPOCH;

        assert!(
            validate_reserve(&request).is_ok(),
            "PostgreSQL should own the authoritative expiry clock"
        );
    }
}

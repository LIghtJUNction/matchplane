use std::{fs, str::FromStr};

use anyhow::Context;
use matchplane_config::{AppConfig, ValidatedConfig};
use matchplane_domain::{
    CausationId, CorrelationId, EventId, FederationNodeId, PayloadHash, Quantity, ShardId,
};
use matchplane_observability::init;
use matchplane_protocol::{timestamp_from_proto, timestamp_to_proto, v1};
use matchplane_storage::{
    FederationReservation, FederationTransition, PgStore, ReserveFederated, StorageError,
};
use sha2::{Digest, Sha256};
use time::{Duration, OffsetDateTime};
use tonic::transport::{Certificate, Identity, Server, ServerTlsConfig};
use tonic::{Request, Response, Status};
use tracing::info;

const PROTOCOL_MAJOR: u32 = 1;
const PROTOCOL_MINOR: u32 = 0;
const MAX_CLOCK_SKEW: Duration = Duration::minutes(5);

#[derive(Debug, Clone)]
struct FederationService {
    store: PgStore,
    target_node_id: FederationNodeId,
    require_tls: bool,
}

#[tonic::async_trait]
impl v1::federation_control_server::FederationControl for FederationService {
    async fn negotiate(
        &self,
        request: Request<v1::NegotiateRequest>,
    ) -> Result<Response<v1::NegotiateResponse>, Status> {
        let fingerprint = self.client_fingerprint(&request)?;
        let message = request.into_inner();
        let source_node_id = parse_id("source_node_id", &message.source_node_id)?;
        validate_nonce(&message.nonce)?;
        let occurred_at = required_timestamp("occurred_at", message.occurred_at.as_ref())?;
        validate_fresh_timestamp(occurred_at)?;
        let (peer_major, peer_minor) = self
            .store
            .federation_node_protocol(source_node_id, &message.nonce, fingerprint.as_deref())
            .await
            .map_err(storage_status)?;
        let selected = select_protocol(&message.supported_versions, peer_major, peer_minor)
            .ok_or_else(|| Status::failed_precondition("no mutually supported protocol version"))?;
        Ok(Response::new(v1::NegotiateResponse {
            selected_version: Some(selected),
            target_node_id: self.target_node_id.to_string(),
        }))
    }

    async fn reserve(
        &self,
        request: Request<v1::ReserveRequest>,
    ) -> Result<Response<v1::ReserveResponse>, Status> {
        let fingerprint = self.client_fingerprint(&request)?;
        let message = request.into_inner();
        validate_reserve_envelope(&message)?;
        let source_node_id = parse_id("source_node_id", &message.source_node_id)?;
        self.store
            .authenticate_federation_node(source_node_id, fingerprint.as_deref())
            .await
            .map_err(storage_status)?;
        let digest: [u8; 32] = message
            .payload_hash
            .as_slice()
            .try_into()
            .map_err(|_| Status::invalid_argument("payload_hash must contain 32 bytes"))?;
        let reservation = self
            .store
            .reserve_federated(&ReserveFederated {
                source_node_id,
                tenant_id: parse_id("tenant_id", &message.tenant_id)?,
                domain_id: parse_id("domain_id", &message.domain_id)?,
                market_id: parse_id("market_id", &message.market_id)?,
                order_id: parse_id("order_id", &message.order_id)?,
                quantity: parse_quantity(&message.quantity)?,
                idempotency_key: message.idempotency_key,
                request_hash: PayloadHash::from_digest(digest),
                fencing_token: message.fencing_token,
                nonce: message.nonce,
                expires_at: required_timestamp("expires_at", message.expires_at.as_ref())?,
            })
            .await
            .map_err(storage_status)?;
        Ok(Response::new(reserve_response(&reservation)))
    }

    async fn confirm(
        &self,
        request: Request<v1::ConfirmRequest>,
    ) -> Result<Response<v1::ReservationResult>, Status> {
        let fingerprint = self.client_fingerprint(&request)?;
        let message = request.into_inner();
        let source_node_id = parse_id("source_node_id", &message.source_node_id)?;
        self.store
            .authenticate_federation_node(source_node_id, fingerprint.as_deref())
            .await
            .map_err(storage_status)?;
        let reservation = self
            .store
            .confirm_federated(&FederationTransition {
                source_node_id,
                reservation_id: parse_id("reservation_id", &message.reservation_id)?,
                idempotency_key: message.idempotency_key,
                expected_version: message.reservation_version,
                fencing_token: message.fencing_token,
                nonce: message.nonce,
            })
            .await
            .map_err(storage_status)?;
        Ok(Response::new(reservation_result(&reservation)))
    }

    async fn abort(
        &self,
        request: Request<v1::AbortRequest>,
    ) -> Result<Response<v1::ReservationResult>, Status> {
        let fingerprint = self.client_fingerprint(&request)?;
        let message = request.into_inner();
        let source_node_id = parse_id("source_node_id", &message.source_node_id)?;
        self.store
            .authenticate_federation_node(source_node_id, fingerprint.as_deref())
            .await
            .map_err(storage_status)?;
        let reservation = self
            .store
            .abort_federated(&FederationTransition {
                source_node_id,
                reservation_id: parse_id("reservation_id", &message.reservation_id)?,
                idempotency_key: message.idempotency_key,
                expected_version: message.reservation_version,
                fencing_token: message.fencing_token,
                nonce: message.nonce,
            })
            .await
            .map_err(storage_status)?;
        Ok(Response::new(reservation_result(&reservation)))
    }
}

impl FederationService {
    fn client_fingerprint<T>(&self, request: &Request<T>) -> Result<Option<String>, Status> {
        if !self.require_tls {
            return Ok(None);
        }
        let certificates = request
            .peer_certs()
            .ok_or_else(|| Status::unauthenticated("a client certificate is required"))?;
        let leaf = certificates
            .first()
            .ok_or_else(|| Status::unauthenticated("a client certificate is required"))?;
        Ok(Some(hex::encode(Sha256::digest(leaf.as_ref()))))
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = AppConfig::load().context("federation hub configuration is invalid")?;
    let telemetry = init(
        "matchplane-federation-hub",
        &config.log_filter,
        &config.otlp_endpoint,
    )
    .context("federation hub observability initialization failed")?;
    let store = PgStore::connect(&config.database_url, 20)
        .await
        .context("federation hub could not connect to PostgreSQL")?;
    let service = FederationService {
        store,
        target_node_id: config.node_id,
        require_tls: config.require_tls,
    };
    let mut server = Server::builder();
    if let Some(tls) = load_server_tls(&config)? {
        server = server
            .tls_config(tls)
            .context("federation hub TLS configuration is invalid")?;
    }
    info!(
        node_id = %config.node_id,
        address = %config.grpc_addr,
        mutual_tls = config.require_tls,
        "federation control plane listening"
    );
    server
        .add_service(v1::federation_control_server::FederationControlServer::new(
            service,
        ))
        .serve_with_shutdown(config.grpc_addr, shutdown_signal())
        .await
        .context("federation gRPC server failed")?;
    telemetry
        .shutdown()
        .context("federation telemetry shutdown failed")?;
    Ok(())
}

fn load_server_tls(config: &ValidatedConfig) -> anyhow::Result<Option<ServerTlsConfig>> {
    if !config.require_tls {
        return Ok(None);
    }
    let certificate = fs::read(&config.tls_certificate_path).with_context(|| {
        format!(
            "could not read federation TLS certificate {}",
            config.tls_certificate_path
        )
    })?;
    let private_key = fs::read(&config.tls_private_key_path).with_context(|| {
        format!(
            "could not read federation TLS private key {}",
            config.tls_private_key_path
        )
    })?;
    let client_ca = fs::read(&config.tls_client_ca_path).with_context(|| {
        format!(
            "could not read federation client CA {}",
            config.tls_client_ca_path
        )
    })?;
    Ok(Some(
        ServerTlsConfig::new()
            .identity(Identity::from_pem(certificate, private_key))
            .client_ca_root(Certificate::from_pem(client_ca)),
    ))
}

fn validate_reserve_envelope(message: &v1::ReserveRequest) -> Result<(), Status> {
    let _: EventId = parse_id("event_id", &message.event_id)?;
    let _: CorrelationId = parse_id("correlation_id", &message.correlation_id)?;
    let _: CausationId = parse_id("causation_id", &message.causation_id)?;
    let _: ShardId = parse_id("shard_id", &message.shard_id)?;
    if message.shard_sequence == 0 {
        return Err(Status::invalid_argument("shard_sequence must be positive"));
    }
    if message.schema_version == 0 {
        return Err(Status::invalid_argument("schema_version must be positive"));
    }
    validate_nonce(&message.nonce)?;
    let occurred_at = required_timestamp("occurred_at", message.occurred_at.as_ref())?;
    validate_fresh_timestamp(occurred_at)
}

fn validate_nonce(nonce: &str) -> Result<(), Status> {
    if !(16..=256).contains(&nonce.len()) {
        return Err(Status::invalid_argument("nonce length must be in 16..=256"));
    }
    Ok(())
}

fn validate_fresh_timestamp(occurred_at: OffsetDateTime) -> Result<(), Status> {
    let now = OffsetDateTime::now_utc();
    if occurred_at < now - MAX_CLOCK_SKEW || occurred_at > now + MAX_CLOCK_SKEW {
        return Err(Status::failed_precondition(
            "federation request timestamp is outside the allowed clock skew",
        ));
    }
    Ok(())
}

fn required_timestamp(
    field: &'static str,
    value: Option<&prost_types::Timestamp>,
) -> Result<OffsetDateTime, Status> {
    timestamp_from_proto(
        value.ok_or_else(|| {
            Status::invalid_argument(format!("required field {field} is missing"))
        })?,
    )
    .map_err(|error| Status::invalid_argument(error.to_string()))
}

fn parse_id<T>(field: &'static str, value: &str) -> Result<T, Status>
where
    T: FromStr<Err = uuid::Error>,
{
    value
        .parse()
        .map_err(|_| Status::invalid_argument(format!("field {field} is not a valid UUID")))
}

fn parse_quantity(value: &str) -> Result<Quantity, Status> {
    let value = value
        .parse::<i128>()
        .map_err(|_| Status::invalid_argument("quantity is not an exact integer"))?;
    Quantity::new(value).map_err(|error| Status::invalid_argument(error.to_string()))
}

fn select_protocol(
    offered: &[v1::ProtocolVersion],
    peer_major: u32,
    peer_minor: u32,
) -> Option<v1::ProtocolVersion> {
    offered
        .iter()
        .filter(|version| {
            version.major == PROTOCOL_MAJOR
                && version.major == peer_major
                && version.minor == PROTOCOL_MINOR
                && version.minor <= peer_minor
        })
        .max_by_key(|version| version.minor)
        .cloned()
}

fn reserve_response(reservation: &FederationReservation) -> v1::ReserveResponse {
    v1::ReserveResponse {
        reservation_id: reservation.reservation_id.to_string(),
        reservation_version: reservation.version,
        fencing_token: reservation.fencing_token,
        expires_at: Some(timestamp_to_proto(reservation.expires_at)),
    }
}

fn reservation_result(reservation: &FederationReservation) -> v1::ReservationResult {
    v1::ReservationResult {
        reservation_id: reservation.reservation_id.to_string(),
        status: reservation.status.clone(),
        reservation_version: reservation.version,
    }
}

fn storage_status(error: StorageError) -> Status {
    match error {
        StorageError::IdempotencyConflict => Status::already_exists(error.to_string()),
        StorageError::NotFound(_) => Status::not_found(error.to_string()),
        StorageError::ReservationUnavailable => Status::resource_exhausted(error.to_string()),
        StorageError::StaleFencingToken | StorageError::InvalidReservationTransition { .. } => {
            Status::failed_precondition(error.to_string())
        }
        StorageError::ReplayDetected => Status::permission_denied(error.to_string()),
        StorageError::ReservationVersionConflict => Status::aborted(error.to_string()),
        StorageError::InvalidData(_) => Status::invalid_argument(error.to_string()),
        StorageError::Forbidden(_) => Status::permission_denied(error.to_string()),
        StorageError::Conflict(_) => Status::aborted(error.to_string()),
        StorageError::Sqlx(_)
        | StorageError::Migration(_)
        | StorageError::InsufficientBalance
        | StorageError::LeaseUnavailable
        | StorageError::Wire(_)
        | StorageError::Engine(_)
        | StorageError::Json(_) => Status::internal("federation persistence failed"),
    }
}

async fn shutdown_signal() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        tracing::error!(%error, "failed to listen for shutdown signal");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_selection_should_choose_latest_compatible_minor() {
        let selected = select_protocol(
            &[
                v1::ProtocolVersion { major: 2, minor: 0 },
                v1::ProtocolVersion { major: 1, minor: 0 },
            ],
            1,
            0,
        );

        assert_eq!(selected, Some(v1::ProtocolVersion { major: 1, minor: 0 }));
    }

    #[test]
    fn protocol_selection_should_reject_incompatible_major() {
        let selected = select_protocol(&[v1::ProtocolVersion { major: 2, minor: 0 }], 1, 0);

        assert!(selected.is_none());
    }
}

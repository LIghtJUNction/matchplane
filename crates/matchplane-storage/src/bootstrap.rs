use std::str::FromStr;

use serde_json::json;
use sha2::{Digest, Sha256};

use crate::{DemoBootstrap, PgStore, StorageError};

impl DemoBootstrap {
    /// Returns the stable identifiers used by local development and smoke tests.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] only if a source-controlled UUID constant is malformed.
    pub fn local() -> Result<Self, StorageError> {
        Ok(Self {
            node_a: parse("00000000-0000-7000-8000-00000000000a")?,
            node_b: parse("00000000-0000-7000-8000-00000000000b")?,
            node_c: parse("00000000-0000-7000-8000-00000000000c")?,
            tenant_id: parse("00000000-0000-7000-8000-000000000100")?,
            automotive_domain_id: parse("00000000-0000-7000-8000-000000000101")?,
            electronics_domain_id: parse("00000000-0000-7000-8000-000000000102")?,
            automotive_schema_id: parse("00000000-0000-7000-8000-000000000201")?,
            electronics_schema_id: parse("00000000-0000-7000-8000-000000000202")?,
            automotive_market_id: parse("00000000-0000-7000-8000-000000000301")?,
            electronics_market_id: parse("00000000-0000-7000-8000-000000000302")?,
            automotive_shard_id: parse("00000000-0000-7000-8000-000000000401")?,
            electronics_shard_id: parse("00000000-0000-7000-8000-000000000402")?,
            buyer_quote_account_id: parse("00000000-0000-7000-8000-000000000501")?,
            buyer_base_account_id: parse("00000000-0000-7000-8000-000000000502")?,
            seller_base_account_id: parse("00000000-0000-7000-8000-000000000503")?,
            seller_quote_account_id: parse("00000000-0000-7000-8000-000000000504")?,
            platform_quote_account_id: parse("00000000-0000-7000-8000-000000000505")?,
            automotive_asset_id: parse("00000000-0000-7000-8000-000000000601")?,
            electronics_asset_id: parse("00000000-0000-7000-8000-000000000602")?,
            embedding_model_id: parse("00000000-0000-7000-8000-000000000701")?,
            test_payment_gateway_id: parse("00000000-0000-7000-8000-000000000801")?,
        })
    }
}

impl PgStore {
    /// Installs idempotent automotive/electronics demo authorities and reference data.
    ///
    /// Both verticals share the same generic schema and matching kernel; only their JSON Schemas
    /// and asset attributes differ.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] if PostgreSQL rejects any reference record.
    pub async fn bootstrap_demo(&self) -> Result<DemoBootstrap, StorageError> {
        let ids = DemoBootstrap::local()?;
        let mut transaction = self.pool().begin().await?;

        sqlx::query(
            "INSERT INTO tenants (id, slug, name) VALUES ($1, 'matchplane-demo', 'MatchPlane Demo') \
             ON CONFLICT (id) DO NOTHING",
        )
        .bind(ids.tenant_id.into_uuid())
        .execute(&mut *transaction)
        .await?;

        for (id, name, endpoint) in [
            (ids.node_a, "node-a-automotive", "https://node-a:50051"),
            (ids.node_b, "node-b-electronics", "https://node-b:50051"),
            (ids.node_c, "node-c-federation-hub", "https://node-c:50051"),
        ] {
            sqlx::query(
                "INSERT INTO federation_nodes \
                 (id, name, grpc_endpoint, signing_key, protocol_major, protocol_minor) \
                 VALUES ($1, $2, $3, 'development-key-reference', 1, 0) \
                 ON CONFLICT (id) DO NOTHING",
            )
            .bind(id.into_uuid())
            .bind(name)
            .bind(endpoint)
            .execute(&mut *transaction)
            .await?;
        }

        for (id, slug, name) in [
            (ids.automotive_domain_id, "automotive", "Automotive"),
            (ids.electronics_domain_id, "electronics", "Electronics"),
        ] {
            sqlx::query(
                "INSERT INTO domains (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4) \
                 ON CONFLICT (id) DO NOTHING",
            )
            .bind(id.into_uuid())
            .bind(ids.tenant_id.into_uuid())
            .bind(slug)
            .bind(name)
            .execute(&mut *transaction)
            .await?;
        }

        let automotive_schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "required": ["vin", "make", "model_year"],
            "properties": {
                "vin": {"type": "string"},
                "make": {"type": "string"},
                "model_year": {"type": "integer"}
            }
        });
        let electronics_schema = json!({
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "type": "object",
            "required": ["sku", "manufacturer", "condition"],
            "properties": {
                "sku": {"type": "string"},
                "manufacturer": {"type": "string"},
                "condition": {"enum": ["new", "refurbished", "used"]}
            }
        });
        for (schema_id, domain_id, document) in [
            (
                ids.automotive_schema_id,
                ids.automotive_domain_id,
                automotive_schema,
            ),
            (
                ids.electronics_schema_id,
                ids.electronics_domain_id,
                electronics_schema,
            ),
        ] {
            let canonical = serde_json::to_vec(&document)?;
            let hash: Vec<u8> = Sha256::digest(&canonical).to_vec();
            sqlx::query(
                "INSERT INTO asset_schemas \
                 (id, tenant_id, domain_id, schema_version, schema_document, schema_hash) \
                 VALUES ($1, $2, $3, 1, $4, $5) ON CONFLICT (id) DO NOTHING",
            )
            .bind(schema_id.into_uuid())
            .bind(ids.tenant_id.into_uuid())
            .bind(domain_id.into_uuid())
            .bind(document)
            .bind(hash)
            .execute(&mut *transaction)
            .await?;
        }

        for (id, domain_id, shard_id, symbol, base_asset, quote_asset, partition) in [
            (
                ids.automotive_market_id,
                ids.automotive_domain_id,
                ids.automotive_shard_id,
                "AUTO-USD",
                "AUTO",
                "USD",
                0_i32,
            ),
            (
                ids.electronics_market_id,
                ids.electronics_domain_id,
                ids.electronics_shard_id,
                "ELEC-USD",
                "ELEC",
                "USD",
                1_i32,
            ),
        ] {
            sqlx::query(
                "INSERT INTO markets \
                 (id, tenant_id, domain_id, shard_id, symbol, base_asset_key, quote_asset_key, \
                  price_scale, quantity_scale, kafka_partition) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 2, 0, $8) \
                 ON CONFLICT (id) DO NOTHING",
            )
            .bind(id.into_uuid())
            .bind(ids.tenant_id.into_uuid())
            .bind(domain_id.into_uuid())
            .bind(shard_id.into_uuid())
            .bind(symbol)
            .bind(base_asset)
            .bind(quote_asset)
            .bind(partition)
            .execute(&mut *transaction)
            .await?;
        }

        for (id, owner, asset, available) in [
            (ids.buyer_quote_account_id, "buyer", "USD", "1000000000"),
            (ids.buyer_base_account_id, "buyer", "AUTO", "0"),
            (ids.seller_base_account_id, "seller", "AUTO", "1000000000"),
            (ids.seller_quote_account_id, "seller", "USD", "0"),
            (ids.platform_quote_account_id, "platform", "USD", "0"),
        ] {
            sqlx::query(
                "INSERT INTO accounts (id, tenant_id, owner_key, asset_key, available_amount) \
                 VALUES ($1, $2, $3, $4, $5::numeric) ON CONFLICT (id) DO NOTHING",
            )
            .bind(id.into_uuid())
            .bind(ids.tenant_id.into_uuid())
            .bind(owner)
            .bind(asset)
            .bind(available)
            .execute(&mut *transaction)
            .await?;
        }

        for (id, domain_id, schema_id, external_key, display_name, attributes) in [
            (
                ids.automotive_asset_id,
                ids.automotive_domain_id,
                ids.automotive_schema_id,
                "demo-auto-001",
                "2026 MatchPlane Demonstrator",
                json!({"vin": "MPDEMO00000000001", "make": "MatchPlane", "model_year": 2026}),
            ),
            (
                ids.electronics_asset_id,
                ids.electronics_domain_id,
                ids.electronics_schema_id,
                "demo-elec-001",
                "MatchPlane Edge Module",
                json!({"sku": "MP-EDGE-001", "manufacturer": "MatchPlane", "condition": "new"}),
            ),
        ] {
            sqlx::query(
                "INSERT INTO assets \
                 (id, tenant_id, domain_id, asset_schema_id, external_key, display_name, attributes) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING",
            )
            .bind(id.into_uuid())
            .bind(ids.tenant_id.into_uuid())
            .bind(domain_id.into_uuid())
            .bind(schema_id.into_uuid())
            .bind(external_key)
            .bind(display_name)
            .bind(attributes)
            .execute(&mut *transaction)
            .await?;
        }

        sqlx::query(
            "INSERT INTO embedding_models \
             (id, tenant_id, domain_id, name, model_version, dimension, metric) \
             VALUES ($1, $2, $3, 'caller-demo-vector', '1', 3, 'cosine') \
             ON CONFLICT (id) DO NOTHING",
        )
        .bind(ids.embedding_model_id.into_uuid())
        .bind(ids.tenant_id.into_uuid())
        .bind(ids.automotive_domain_id.into_uuid())
        .execute(&mut *transaction)
        .await?;

        sqlx::query(
            "UPDATE markets SET platform_commission_account_id = $2, commission_bps = 100 \
             WHERE tenant_id = $1 AND quote_asset_key = 'USD'",
        )
        .bind(ids.tenant_id.into_uuid())
        .bind(ids.platform_quote_account_id.into_uuid())
        .execute(&mut *transaction)
        .await?;

        sqlx::query(
            "INSERT INTO payment_gateway_configs \
             (id, tenant_id, name, gateway_kind, mode, settings) \
             VALUES ($1, $2, 'deterministic-sandbox', 'test', 'test', '{}'::jsonb) \
             ON CONFLICT (id) DO NOTHING",
        )
        .bind(ids.test_payment_gateway_id.into_uuid())
        .bind(ids.tenant_id.into_uuid())
        .execute(&mut *transaction)
        .await?;

        sqlx::query(
            "INSERT INTO payment_settings (tenant_id, active_mode, updated_by) \
             VALUES ($1, 'test', 'bootstrap') ON CONFLICT (tenant_id) DO NOTHING",
        )
        .bind(ids.tenant_id.into_uuid())
        .execute(&mut *transaction)
        .await?;

        sqlx::query(
            "INSERT INTO payment_routes \
             (id, tenant_id, gateway_id, method_code, currency, priority) \
             VALUES ('00000000-0000-7000-8000-000000000802', $1, $2, '*', '*', 100) \
             ON CONFLICT (id) DO NOTHING",
        )
        .bind(ids.tenant_id.into_uuid())
        .bind(ids.test_payment_gateway_id.into_uuid())
        .execute(&mut *transaction)
        .await?;

        sqlx::query(
            "INSERT INTO invoice_provider_configs \
             (id, tenant_id, provider_key, name, mode, settings) \
             VALUES ('00000000-0000-7000-8000-000000000803', $1, 'local_test', \
                     'deterministic-invoice-sandbox', 'test', '{}'::jsonb) \
             ON CONFLICT (id) DO NOTHING",
        )
        .bind(ids.tenant_id.into_uuid())
        .execute(&mut *transaction)
        .await?;

        sqlx::query(
            "INSERT INTO invoice_settings (tenant_id, active_mode, active_provider_id, updated_by) \
             VALUES ($1, 'test', '00000000-0000-7000-8000-000000000803', 'bootstrap') \
             ON CONFLICT (tenant_id) DO NOTHING",
        )
        .bind(ids.tenant_id.into_uuid())
        .execute(&mut *transaction)
        .await?;

        transaction.commit().await?;
        Ok(ids)
    }
}

fn parse<T>(value: &str) -> Result<T, StorageError>
where
    T: FromStr<Err = uuid::Error>,
{
    value
        .parse()
        .map_err(|error: uuid::Error| StorageError::InvalidData(error.to_string()))
}

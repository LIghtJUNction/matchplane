use std::fmt::Write;

use matchplane_domain::FederationNodeId;
use sha2::{Digest, Sha256};
use sqlx::Row;

use crate::{CandidateMatch, PgStore, StorageError, VectorRecord};

impl PgStore {
    /// Upserts a caller-provided embedding into the dimension-partitioned pgvector table.
    ///
    /// MatchPlane validates the registered model and finite values but deliberately does not
    /// pretend to run an AI model.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] for a model/scope mismatch, wrong dimension, non-finite value, or
    /// PostgreSQL failure.
    pub async fn upsert_embedding(&self, record: &VectorRecord) -> Result<(), StorageError> {
        let (dimension, _metric) = self
            .embedding_model(record)
            .await?
            .ok_or(StorageError::NotFound("embedding model"))?;
        validate_vector(&record.values, dimension)?;
        let vector = vector_literal(&record.values)?;
        let mut hasher = Sha256::new();
        for value in &record.values {
            hasher.update(value.to_le_bytes());
        }
        let content_hash: Vec<u8> = hasher.finalize().to_vec();
        sqlx::query(
            "INSERT INTO asset_embeddings \
             (tenant_id, domain_id, asset_id, embedding_model_id, dimension, embedding, content_hash) \
             VALUES ($1, $2, $3, $4, $5, $6::vector, $7) \
             ON CONFLICT (asset_id, embedding_model_id, dimension) DO UPDATE SET \
                 embedding = EXCLUDED.embedding, content_hash = EXCLUDED.content_hash",
        )
        .bind(record.tenant_id.into_uuid())
        .bind(record.domain_id.into_uuid())
        .bind(record.asset_id.into_uuid())
        .bind(record.embedding_model_id.into_uuid())
        .bind(dimension)
        .bind(vector)
        .bind(content_hash)
        .execute(self.pool())
        .await?;
        Ok(())
    }

    /// Retrieves nearest candidate assets under the registered model's distance metric.
    ///
    /// Results are advisory only; callers must route candidates to a deterministic authority for
    /// reservations and matching.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError`] for an unknown model, invalid vector, or query failure.
    pub async fn search_candidates(
        &self,
        query: &VectorRecord,
        source_node_id: FederationNodeId,
        limit: i64,
    ) -> Result<Vec<CandidateMatch>, StorageError> {
        let (dimension, metric) = self
            .embedding_model(query)
            .await?
            .ok_or(StorageError::NotFound("embedding model"))?;
        validate_vector(&query.values, dimension)?;
        let vector = vector_literal(&query.values)?;
        let operator = match metric.as_str() {
            "cosine" => "<=>",
            "l2" => "<->",
            "inner_product" => "<#>",
            other => {
                return Err(StorageError::InvalidData(format!(
                    "unknown embedding metric {other}"
                )));
            }
        };
        let distance_expression = if dimension > 2_000 {
            format!("embedding::halfvec({dimension}) {operator} $5::halfvec({dimension})")
        } else {
            format!("embedding {operator} $5::vector")
        };
        let statement = format!(
            "SELECT asset_id, embedding_model_id, ({distance_expression})::float8 AS distance \
             FROM asset_embeddings \
             WHERE tenant_id = $1 AND domain_id = $2 AND embedding_model_id = $3 AND dimension = $4 \
             ORDER BY {distance_expression} LIMIT $6"
        );
        // `operator` is selected exclusively from the closed enum-like match above; caller input
        // never enters SQL syntax. SQLx 0.9 requires this explicit audit marker for dynamic SQL.
        let rows = sqlx::query(sqlx::AssertSqlSafe(statement))
            .bind(query.tenant_id.into_uuid())
            .bind(query.domain_id.into_uuid())
            .bind(query.embedding_model_id.into_uuid())
            .bind(dimension)
            .bind(vector)
            .bind(limit.clamp(1, 100))
            .fetch_all(self.pool())
            .await?;
        rows.into_iter()
            .map(|row| {
                Ok(CandidateMatch {
                    asset_id: matchplane_domain::AssetId::from_uuid(row.try_get("asset_id")?),
                    embedding_model_id: matchplane_domain::EmbeddingModelId::from_uuid(
                        row.try_get("embedding_model_id")?,
                    ),
                    distance: row.try_get("distance")?,
                    source_node_id,
                })
            })
            .collect()
    }

    async fn embedding_model(
        &self,
        record: &VectorRecord,
    ) -> Result<Option<(i32, String)>, StorageError> {
        let row = sqlx::query(
            "SELECT dimension, metric FROM embedding_models \
             WHERE id = $1 AND tenant_id = $2 AND domain_id = $3 AND active",
        )
        .bind(record.embedding_model_id.into_uuid())
        .bind(record.tenant_id.into_uuid())
        .bind(record.domain_id.into_uuid())
        .fetch_optional(self.pool())
        .await?;
        row.map(|row| Ok((row.try_get("dimension")?, row.try_get("metric")?)))
            .transpose()
    }
}

fn validate_vector(values: &[f32], expected_dimension: i32) -> Result<(), StorageError> {
    let dimension = i32::try_from(values.len())
        .map_err(|_| StorageError::InvalidData("embedding dimension exceeds i32".to_owned()))?;
    if dimension != expected_dimension {
        return Err(StorageError::InvalidData(format!(
            "embedding dimension must be {expected_dimension}, received {dimension}"
        )));
    }
    if values.iter().any(|value| !value.is_finite()) {
        return Err(StorageError::InvalidData(
            "embedding values must all be finite".to_owned(),
        ));
    }
    Ok(())
}

fn vector_literal(values: &[f32]) -> Result<String, StorageError> {
    let mut result = String::from('[');
    for (index, value) in values.iter().enumerate() {
        if index > 0 {
            result.push(',');
        }
        write!(&mut result, "{value}")
            .map_err(|error| StorageError::InvalidData(error.to_string()))?;
    }
    result.push(']');
    Ok(result)
}

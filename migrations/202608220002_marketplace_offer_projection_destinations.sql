-- Bind each durable projection request to the exact immutable child release/path/tool key that
-- was active when it was created. Endpoint URLs and bearer tokens remain operator-owned and may
-- rotate behind the stable MCP server key.

ALTER TABLE marketplace_offer_projection_jobs
    ADD COLUMN registration_id uuid REFERENCES subplatform_registrations(id) ON DELETE RESTRICT,
    ADD COLUMN platform_path text,
    ADD COLUMN mcp_server_key text;

UPDATE marketplace_offer_projection_jobs job
   SET registration_id = store.current_registration_id,
       platform_path = alias.path,
       mcp_server_key = COALESCE(
           NULLIF(registration.manifest -> 'agent' ->> 'mcpServerKey', ''),
           registration.slug
       ),
       updated_at = clock_timestamp()
  FROM stores store
  JOIN store_path_aliases alias
    ON alias.tenant_id = store.tenant_id
   AND alias.store_id = store.id
   AND alias.is_canonical
  JOIN subplatform_registrations registration
    ON registration.id = store.current_registration_id
   AND registration.tenant_id = store.tenant_id
   AND registration.domain_id = store.domain_id
 WHERE job.tenant_id = store.tenant_id
   AND job.domain_id = store.domain_id
   AND job.store_id = store.id;

ALTER TABLE marketplace_offer_projection_jobs
    ADD CONSTRAINT marketplace_offer_projection_jobs_destination_shape_check CHECK (
      (registration_id IS NULL AND platform_path IS NULL AND mcp_server_key IS NULL)
      OR (
        registration_id IS NOT NULL
        AND platform_path IS NOT NULL
        AND platform_path ~ '^/(?:[a-z0-9-]+(?:/[a-z0-9-]+)*)$'
        AND length(platform_path) <= 512
        AND mcp_server_key IS NOT NULL
        AND mcp_server_key ~ '^[a-z0-9][a-z0-9._-]{0,127}$'
      )
    );

-- Keep the earlier version-only unique constraint during the rolling binary deployment.  The
-- following migration removes it only after every writer understands immutable destinations.
ALTER TABLE marketplace_offer_projection_jobs
    ADD CONSTRAINT marketplace_offer_projection_jobs_destination_version_key
        UNIQUE (tenant_id, offer_id, canonical_version, registration_id);

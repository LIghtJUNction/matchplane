-- Root marketplace home configuration, account-scoped product likes, and durable user notifications.

ALTER TABLE tenants
    ADD COLUMN home_placeholder_phrases jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN include_active_product_titles boolean NOT NULL DEFAULT false;

ALTER TABLE tenants
    ADD CONSTRAINT tenants_home_placeholder_phrases_array
        CHECK (
            jsonb_typeof(home_placeholder_phrases) = 'array'
            AND jsonb_array_length(home_placeholder_phrases) <= 64
        );

CREATE TABLE marketplace_offer_likes (
    tenant_id uuid NOT NULL,
    offer_id uuid NOT NULL,
    auth_user_id uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    like_count smallint NOT NULL
        CONSTRAINT marketplace_offer_likes_count_check
        CHECK (like_count BETWEEN 1 AND 5),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, offer_id, auth_user_id),
    FOREIGN KEY (tenant_id, offer_id)
        REFERENCES marketplace_offers(tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX marketplace_offer_likes_user_idx
    ON marketplace_offer_likes (auth_user_id, tenant_id, updated_at DESC);

CREATE TRIGGER marketplace_offer_likes_updated_at
BEFORE UPDATE ON marketplace_offer_likes
FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();

CREATE TABLE user_notifications (
    id uuid PRIMARY KEY,
    recipient_auth_user_id uuid NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
    platform_path text NOT NULL DEFAULT '/'
        CHECK (platform_path LIKE '/%' AND length(platform_path) BETWEEN 1 AND 512),
    kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 80),
    source_type text NOT NULL CHECK (length(source_type) BETWEEN 1 AND 80),
    source_id text NOT NULL CHECK (length(source_id) BETWEEN 1 AND 256),
    title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    body text CHECK (body IS NULL OR length(body) <= 500),
    payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    action_path text NOT NULL
        CHECK (action_path LIKE '/%' AND action_path NOT LIKE '//%' AND length(action_path) BETWEEN 1 AND 1024),
    read_at timestamptz,
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (recipient_auth_user_id, source_type, source_id, kind)
);

CREATE INDEX user_notifications_recipient_time_idx
    ON user_notifications (recipient_auth_user_id, created_at DESC, id DESC)
    WHERE archived_at IS NULL;

CREATE INDEX user_notifications_unread_idx
    ON user_notifications (recipient_auth_user_id, created_at DESC, id DESC)
    WHERE read_at IS NULL AND archived_at IS NULL;

CREATE TRIGGER user_notifications_updated_at
BEFORE UPDATE ON user_notifications
FOR EACH ROW EXECUTE FUNCTION matchplane_set_updated_at();

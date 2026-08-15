-- Persist the bounded AI/policy decision separately from the public route plan.
-- This keeps provider/model metadata auditable without putting secrets or a raw prompt
-- into the routing record. The route plan remains the authorized child references.
ALTER TABLE platform_match_requests
    ADD COLUMN routing_decision jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(routing_decision) = 'object');

CREATE INDEX platform_match_requests_routing_source_idx
    ON platform_match_requests ((routing_decision ->> 'source'), created_at DESC);

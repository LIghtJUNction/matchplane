-- Agent stage taxonomy belongs to the mounted domain, not to the root kernel.
-- Keep the existing examples valid while allowing future domains (for example
-- services or compatibility matching) to use their own bounded stage keys.
ALTER TABLE platform_agent_handoffs
    DROP CONSTRAINT IF EXISTS platform_agent_handoffs_stage_check;

ALTER TABLE platform_agent_handoffs
    ADD CONSTRAINT platform_agent_handoffs_stage_check
    CHECK (stage ~ '^[a-z0-9][a-z0-9._:-]{1,127}$');

BEGIN;

ALTER TABLE shopping_memory_profiles
    ALTER COLUMN enabled SET DEFAULT true;

COMMENT ON TABLE shopping_memory_profiles IS
    'AI-maintained shopping defaults for a signed-in customer, with user-visible review, pause and deletion controls.';
COMMENT ON COLUMN shopping_memory_profiles.enabled IS
    'User control switch; when false, the shopping Agent neither recalls nor updates facts.';
COMMENT ON COLUMN shopping_memory_profiles.facts IS
    'Bounded AI summary of budget, purpose, preference, or exclusion facts; users can revise it through the memory assistant.';

COMMIT;

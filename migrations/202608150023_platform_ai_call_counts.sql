-- A recursive match request can invoke one hosted router call per visited
-- platform node. Count calls explicitly so the hourly admission limit cannot
-- be bypassed merely by adding another active child platform.
ALTER TABLE platform_ai_usage
    ADD COLUMN model_calls integer NOT NULL DEFAULT 0
        CHECK (model_calls BETWEEN 0 AND 16);

UPDATE platform_ai_usage
   SET model_calls = CASE WHEN source = 'ai' THEN 1 ELSE 0 END
 WHERE model_calls = 0
   AND source = 'ai';

CREATE INDEX platform_ai_usage_user_calls_idx
    ON platform_ai_usage (auth_user_id, created_at DESC, model_calls);

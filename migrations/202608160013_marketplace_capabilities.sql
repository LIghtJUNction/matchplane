-- Domain-neutral marketplace capability projection.
--
-- `role` is retained for old vehicle-era integrations and membership projections.  New generic
-- routes authorize the stable kernel sides below, so a vertical can label them however it likes.
ALTER TABLE marketplace_parties
    ADD COLUMN marketplace_sides text[] NOT NULL DEFAULT ARRAY['demand', 'supply']::text[];

UPDATE marketplace_parties
SET marketplace_sides = CASE role
    WHEN 'buyer' THEN ARRAY['demand']::text[]
    WHEN 'seller' THEN ARRAY['supply']::text[]
    ELSE ARRAY['demand', 'supply']::text[]
END
WHERE marketplace_sides = ARRAY['demand', 'supply']::text[];

ALTER TABLE marketplace_parties
    ADD CONSTRAINT marketplace_parties_sides_check
    CHECK (
        cardinality(marketplace_sides) BETWEEN 1 AND 2
        AND marketplace_sides <@ ARRAY['demand', 'supply']::text[]
    );

CREATE INDEX marketplace_parties_sides_idx
    ON marketplace_parties USING gin (marketplace_sides);

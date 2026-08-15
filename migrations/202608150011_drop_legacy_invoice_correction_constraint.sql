-- Databases created before the named correction-state constraint was added
-- retain PostgreSQL's anonymous invoice_requests_check1 constraint.  Remove
-- it explicitly so refund red-letter operations can claim their durable state.
ALTER TABLE invoice_requests
    DROP CONSTRAINT IF EXISTS invoice_requests_check1;

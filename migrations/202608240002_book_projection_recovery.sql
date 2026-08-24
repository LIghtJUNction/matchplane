-- no-transaction

-- Cache repair loads only the latest full order-book replacement for one market. Build the
-- partial index without blocking domain-event writers during a production migration.
CREATE INDEX CONCURRENTLY IF NOT EXISTS domain_events_latest_book_projection_idx
    ON domain_events (market_id, shard_sequence DESC)
    WHERE stream_kind = 'order_book_delta';

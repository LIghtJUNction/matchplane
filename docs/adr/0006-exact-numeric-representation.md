# ADR 0006: Exact numeric representation

- Status: Accepted
- Date: 2026-08-14

## Decision

The engine represents price, quantity, and money as validated `i128` newtypes with checked
arithmetic. Markets define `price_scale` and `quantity_scale`. PostgreSQL uses `NUMERIC(38,0)` and
wire JSON encodes integer values as strings where JavaScript precision would be unsafe.

# ADR 0008: Federated reservation saga

- Status: Accepted
- Date: 2026-08-14

## Decision

Cross-node matching uses expiring and idempotent reservations followed by confirm or abort. Requests
carry node identity, protocol version, nonce, payload signature hooks, idempotency key, and fencing
token. Source nodes retain final commit authority; no distributed database transaction is used.

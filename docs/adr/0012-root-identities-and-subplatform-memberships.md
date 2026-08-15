# ADR 0012: Recursive platform identities with path-scoped memberships

## Status

Accepted. The automotive experience is the first platform-node instance, not the platform model.

## Decision

1. Every platform node owns the account, Better Auth authentication, scoped capability bridge,
   contact encryption, audit, payment and matching interfaces. The current deployment root is the
   node with no parent; it does not encode a vertical's presentation or listing copy.
2. A platform node is selected by a path such as `/auto` and may itself own child nodes. The path
   resolves to a tenant/domain configuration containing its brand, UI adapter, schema, ranking
   policy, account labels and revenue policy. The same gateway and matching kernel serve every path.
3. A platform identity can claim many child platforms. The durable relationship is
   `marketplace_subplatform_memberships (tenant_id, domain_id, party_id)`, with a scoped role
   (`buyer`, `seller`, `both`, or scoped `admin`), labels, approval state and audit timestamps.
   Joining `/auto` does not create a second account. An `admin` membership is limited to that
   platform node unless an explicit parent/child management relationship grants descendant access.
4. Platform UI owns its visual language, domain fields, filters and copy. It calls parent/root APIs
   using the Better Auth identity and includes the selected domain/membership scope on every command.
5. A membership must be active before a role-sensitive operation (publishing supply, creating a
   demand request, accepting a contact introduction) is authorized. A root operator may suspend or
   revoke a membership without deleting the account or its cross-subplatform audit history.

## Consequences

- A seller can be tagged `seller` in `/auto`, `provider` in another platform node, and `both` in a
  third without duplicating credentials or contacts.
- The web build can remain a replaceable platform adapter while Rust services stay vertical-neutral.
- Path routing, membership checks and tenant/domain identifiers are security boundaries; a UI label
  alone is never authorization.
- Existing vehicle tables remain an adapter. New verticals should add domain schemas and UI packages,
  then reuse root `MatchIntent`, `MatchIntroduction`, contact consent and promotion/payment APIs.

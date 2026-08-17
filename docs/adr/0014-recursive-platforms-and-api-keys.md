# ADR 0014: Recursive platforms and organization API keys

## Status

Accepted

## Context

The words “root platform” and “subplatform” describe deployment position, not separate product
architectures. A platform installed by another operator may itself host additional verticals. The
same identity, UI adapter, payment boundary, audit rules, and registration API must work at every
level. Platform adapters also need machine credentials without inventing another authentication
system.

## Decision

1. A platform node is a Better Auth Organization with an optional `parentOrganizationId`. The node
   with no parent is the current deployment root; a child may create or register further children
   when its scoped role permits it.
   When a deployment root is mounted into another deployment, the receiving deployment creates a
   signed remote-node projection instead of reparenting the source root organization. This lets the
   source keep its own local root and descendants while appearing as an ordinary child to the
   receiving tree.
2. Better Auth's Organization plugin remains the authority for human membership and roles. The
   parent relationship is checked before any ancestor manager acts on a descendant; target-node
   data, payment settings, contact consent and audit history are never merged across nodes.
   Registration adds the delegating parent manager as an owner/admin member of the child so the
   Better Auth organization-owned key plugin can enforce the same relationship without a bypass.
3. Machine credentials use Better Auth's organization-owned API Key plugin with configuration ID
   `platform`, `mpk_` prefix, hashed storage, expiry, rate limiting, and explicit resource/action
   permissions. API keys do not create mock user sessions.
4. Requests must declare the target organization/platform scope. The root verifies the key with
   Better Auth, checks the key's organization and the platform-tree relationship, then forwards a
   narrowly scoped command. A key cannot widen its own scope through metadata or a request body.
5. Key rotation is create-new → deploy → revoke-old. Raw key material is returned only once and is
   never stored in manifests, logs, browser storage, or PostgreSQL plaintext.

## Consequences

- A platform can be mounted under another platform without a forked API or a second account system.
- Root operators can manage the whole descendant tree, while child operators remain bounded by the
  relationship explicitly granted during registration.
- Better Auth supplies creation, hashing, verification, ownership, expiry, rate limiting and
  revocation; MatchPlane only adds platform-tree authorization and domain policy.
- Existing operator bearers remain an internal service-to-service compatibility path during
  migration. New platform adapters should use the organization API-key contract.

# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Existing production codebase: Next.js with Bun for the web surface, Rust for the gateway and
domain kernel, PostgreSQL for durable state, and MCP/Skill contracts for Agent integrations.

## Users

- Buyers and other demand-side participants who describe what they need in natural language.
- Sellers and other supply-side participants who publish their own offers and may bring their own
  Agent.
- Root platform administrators who operate the shared framework, platform tree, API keys, and
  global policy.
- Subplatform administrators and moderators who manage one mounted vertical, its members, schema,
  retrieval adapter, email route, and publication workflow.
- External buyer/seller Agents that continue multi-step matching with their own model credentials
  and token budget.

## Product Purpose

MatchPlane is a domain-neutral negotiation and matching platform. A participant starts with a
natural-language goal; the platform Agent routes it through active nested platforms, then a
subplatform Agent selects merchants and canonical offers. The platform records an auditable,
consent-controlled introduction, after which participants may exchange approved contact channels
and continue an online or offline transaction. Success means a participant can find a relevant
counterpart without every vertical needing a separate deployment or account system.

## Positioning

The product is one recursively composable platform rather than separate root and vertical
applications. Any node can be mounted under another node, while each vertical owns its schema and
retrieval implementation. The root supplies stable identity, authorization, routing, MCP/Agent
boundaries, consent, payment hooks, and audit without taking ownership of a vertical's catalogue
or vector database.

## Operating Context

The deployment root serves `/` and active subplatforms at paths such as `/used-car` from one web
process. Every path exposes the same chat-first entry and can route to activated descendants.
Better Auth owns email accounts, sessions, organizations, roles, and API keys. Rust exposes the
tenant-scoped marketplace and payment interfaces. External Agents use the HTTP MCP facade or
advertised subplatform MCP tools; caller-funded Agents own their provider credentials and token
costs. Sellers may pay for exposure when a transaction continues offline, while contact release
remains a separate explicit consent step.

## Capabilities and Constraints

- Root and subplatform nodes share one recursive data model; root versus child is a deployment
  position, not a different application.
- Demand, supply, intent, offer, match, introduction, payment, invoice, refund, and contact
  contracts are domain-neutral. Vehicle tables remain compatibility adapters only.
- Sellers define their own domain attributes and terms. The root must not hard-code vehicle fields
  or invent supply data.
- Each subplatform may own its retrieval implementation, including its vector store, through its
  Agent, Skill, and MCP tools. The root only verifies scope, bounded results, lifecycle, consent,
  and audit invariants.
- Buyers and sellers may connect their own Agents. Hosted routing is bounded and audited; no
  platform model call may grant contact, payment, administrator, or transaction authority.
- Better Auth is the sole user authentication system. Party capabilities are short-lived,
  tenant-scoped integration credentials, not a second login system.
- Payment is isolated behind standard gateway interfaces with production and test modes, including
  the configured EPay, Waffo Pancake, WeChat Pay, and Alipay extension points.
- MIT licensing is required for the repository.
- The web interface must remain clean and simple, use the requested Anthropic-art sensibility and
  Apple-design shape/motion guidance, and keep every visible control genuinely usable.

## Brand Commitments

The product name is MatchPlane. The user has committed to a clean, restrained, chat-first
interface with Anthropic-art visual character and Apple-design principles for shape, materials,
motion, and responsive interaction. Domain-specific copy, imagery, and catalogue content belong
to each subplatform or seller and must not be fabricated by the root.

## Evidence on Hand

- Root web application: `web/`.
- Rust services and shared domain/storage crates: `services/` and `crates/`.
- Recursive subplatform contract: `docs/subplatform-contract.md`.
- Automotive adapter as a Git submodule: `subplatforms/auto/`.
- HTTP MCP facade and Agent handoff: `web/app/api/mcp/` and
  `web/app/api/platform/agent/handoff/`.
- No approved customer testimonials, catalogue fixtures, or universal vertical content are on
  hand; future surfaces must not present fabricated inventory or proof.

## Product Principles

1. Keep the kernel generic; let each vertical own meaning, schema, retrieval, and presentation.
2. Compose platforms recursively without multiplying processes, accounts, or credential stores.
3. Treat Agents as bounded decision makers; keep authority in explicit authenticated state changes.
4. Make introductions useful and auditable while requiring consent before contact release.
5. Prefer clear, quiet interfaces that make the next action obvious and keep controls functional.

## Accessibility & Inclusion

The primary interaction is natural-language chat, but all actions must remain keyboard reachable,
screen-reader labelled, focus-visible, and usable on narrow screens. Error, loading, authentication,
consent, and empty states must be explicit rather than communicated only through color or motion.

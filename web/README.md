# @matchplane/web

The official web frontend for MatchPlane — providing the root matching marketplace, multi-tenant merchant storefronts, unified Better Auth authentication, passkey management, AI shopping assistant chat, and platform operations.

---

## Features

- **Chat-First Match Engine**: Natural language buyer intent understanding and explainable match cards.
- **Unified Identity**: Integrated Better Auth with passkeys, passwords, OAuth, identity bindings, and session management.
- **Multi-Tenant Subplatforms & Stores**: Dynamically mounted storefront manifests, custom branding, hosted and remote store onboarding.
- **Store & Mall Operations**: Store catalog moderation, staff management, commercial terms, and payment mode switching.
- **Apple-Inspired Design System**: Low-noise Anthropic editorial aesthetic, physics-based motion transitions, and light/dark theme tokens.

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) `>= 1.3.14`
- [Node.js](https://nodejs.org/) `>= 22.12.0`

### Installation & Development

```bash
# Install workspace dependencies
bun install

# Start local Next.js development server on port 4173
bun run dev

# Run unit and component integration tests (Vitest)
bun run test

# Run tests and production Turbopack build
bun run check
```

---

## Project Structure

- `app/`: Next.js App Router entry points, static pages, and Route Handlers (`/api/*`).
- `src/App.tsx`: High-level declarative orchestrator.
- `src/hooks/`: Domain custom hooks (`useAuthSession`, `useSubplatformRoute`, `useOwnedStores`, `useStoreHandoff`, `useMarketplaceCatalog`).
- `src/components/`: Modular component domain directories (`shell/`, `account/`, `marketplace/`, `store/`, `admin/`, `Primitives.tsx`).
- `src/lib/`: Better Auth client, preference store, and marketplace session helpers.
- `src/styles.css`: Tailwind CSS v4 setup and semantic design tokens.

For in-depth architectural details, see [docs/frontend-architecture.md](../docs/frontend-architecture.md) and [ADR 0018](../docs/adr/0018-frontend-modularization-and-domain-driven-decoupling.md).

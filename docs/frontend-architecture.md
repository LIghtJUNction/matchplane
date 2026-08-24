# MatchPlane Frontend Architecture

This document describes the architectural layout, core patterns, state management, and conventions of the MatchPlane web interface (`web/`).

---

## 1. Technology Stack

- **Framework**: [Next.js 16](https://nextjs.org/) (App Router, Turbopack, Standalone Output)
- **Runtime & UI Library**: [React 19](https://react.dev/), [Motion](https://motion.dev/) (Framer Motion 13)
- **Styling**: [Tailwind CSS v4](https://tailwindcss.com/) + Theme Tokens (`styles.css`, `retail-ui.css`)
- **UI Primitives**: `@appica/ui-react`, `lucide-react`
- **Identity & Auth**: [Better Auth](https://better-auth.com/) (Passkey, OAuth Provider, API Keys)
- **Package Manager & Tooling**: [Bun](https://bun.sh/), [Vitest](https://vitest.dev/), Testing Library

---

## 2. Directory Structure

```text
web/
├── app/                        # Next.js App Router entry points and API routes
│   ├── layout.tsx              # Root HTML shell with theme initialization
│   ├── page.tsx                # Root marketplace mount point
│   ├── [...platformPath]/      # Dynamic subplatform storefront routes
│   ├── admin/                  # Admin registration and settings routes
│   ├── login/, register/       # Unified authentication pages
│   └── api/                    # Route handlers (auth, mall, platform, stores)
├── src/                        # Core React application source
│   ├── App.tsx                 # High-level declarative application orchestrator
│   ├── hooks/                  # Domain-driven custom hooks
│   │   ├── useAuthSession.ts   # Better Auth session & retry state machine
│   │   ├── useSubplatformRoute.ts # Route parsing & URL history synchronization
│   │   ├── useOwnedStores.ts   # Store console context & merchant permissions
│   │   ├── useStoreHandoff.ts  # Contact consent & AI handoff ticket workflows
│   │   ├── useMarketplaceCatalog.ts # Catalog streams & recommendations
│   │   └── index.ts            # Hooks barrel export
│   ├── components/             # Domain-organized UI components
│   │   ├── shell/              # Navigation, headers, and overlay host
│   │   │   ├── PlatformHeader.tsx
│   │   │   ├── SubplatformFullscreenHeader.tsx
│   │   │   └── PlatformOverlaysHost.tsx
│   │   ├── account/            # Profiles, passkeys, bindings, password, sessions
│   │   ├── marketplace/        # Chat-first matching, cards, shopping clerk
│   │   ├── store/              # Storefront views, onboarding, merchant console
│   │   ├── admin/              # Platform dashboards, moderation, site configs
│   │   ├── Primitives.tsx      # Low-level layout and brand primitives
│   │   └── index.ts            # Centralized component export
│   ├── lib/                    # Authentication client, preferences, API helpers
│   ├── subplatform.ts          # Subplatform manifest parsing and resolution
│   ├── api.ts                  # Backend API client functions
│   └── styles.css              # Theme variables, typography, and layout rules
└── package.json
```

---

## 3. Core Architectural Layers

### 3.1 Declarative App Orchestrator (`App.tsx`)
`App.tsx` acts as the root composer. It does not manage low-level async state directly; instead, it coordinates custom domain hooks and delegates rendering to:
- **Header Layer**: `<PlatformHeader>` or `<SubplatformFullscreenHeader>`
- **Workspace Layer**: `<MarketplaceHome>`, `<StorefrontView>`, `<PluginHost>`, or `<PlatformDashboard>`
- **Overlays Layer**: `<PlatformOverlaysHost>`
- **Footer Layer**: `<PlatformFooter>`

### 3.2 Domain Hooks Layer (`src/hooks/`)
1. **`useAuthSession`**:
   - Resolves Better Auth sessions with a 5-step exponential backoff retry loop for transient network glitches (`408`, `429`, `5xx`).
   - Checks recent pending authentication flags to avoid premature redirect to login.
   - Enforces workspace role constraints (`rootAdmin` / `rootSuperAdmin` for platform management).
   - Provides safe, idempotent `signOut()` and `openSignIn()`.
2. **`useSubplatformRoute`**:
   - Resolves subplatform configurations statically from route paths and loads dynamic manifests.
   - Consumes and cleans URL query parameters (`?account=`, `?stores=1`, `?console=`, `?publish=1`).
   - Synchronizes workspace role with browser URL history without unmounted transitions.
3. **`useOwnedStores`**:
   - Fetches owned stores with retries.
   - Manages store console opening, context switching, and role-based permissions (`canManageStore`).
4. **`useStoreHandoff`**:
   - Generates deterministic hash keys for intent idempotency.
   - Handles buyer contact consent exchange requests and customer handoff notifications to store clerks.
5. **`useMarketplaceCatalog`**:
   - Manages asset listings, liking states, search result replacements, and recommendation feeds.

### 3.3 Shell & Overlays Host (`src/components/shell/`)
- **`PlatformOverlaysHost`** centralizes all bottom sheets, dialogs, and toast messages in one place:
  - `WorkspaceSettingsDialog` for Store Console (with `SubplatformAdminDashboard`)
  - `WorkspaceSettingsDialog` for Account Settings (Profile, Account, Passkey, Bindings, Password, Sessions, My Stores)
  - `ListingSheet` for item details & contact exchange
  - `ModeDialog` for payment environment switching (test vs. production)
  - `AppNotice` for accessible toast alerts

---

## 4. UI & Interaction Design Standards

- **Chat-First Experience**: Primary user journey centers on conversational matching and explainable recommendations.
- **Apple Design Motion**: Standardized spring physics (`spring = { type: "spring", bounce: 0, duration: 0.38 }`) with strict `reducedMotion="user"` support.
- **Dark/Light Theme Tokens**: Colors and elevation surfaces derive from CSS variables (`--ink`, `--ivory`, `--paper`, `--cactus`, `--clay`, `--surface`).
- **Responsive Layout**: Designed for seamless degradation from `320px` mobile viewports to `1440px` wide desktops.

---

## 5. Development & Testing Workflow

```bash
# Run unit & component integration tests
bun run test

# Run type checks and production Next.js build
bun run check

# Start development server on port 4173
bun run dev
```

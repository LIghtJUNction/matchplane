# ADR 0018: Frontend Modularization and Domain-Driven Decoupling

## Status

Accepted

## Context

The MatchPlane frontend (`web/`) is built on Next.js 16, React 19, Tailwind CSS v4, and Better Auth. As the product grew to support root marketplace matching, hosted/remote multi-tenant storefronts, Better Auth authentication sessions, passkeys, identity bindings, store consoles, and platform operations, the central `App.tsx` component expanded into a 1600-line monolithic controller.

This created several architectural challenges:
1. **High Cognitive & Maintenance Overhead**: `App.tsx` coupled auth retry state machines, URL query parameter parsing and history synchronization, 15+ modal sheets/dialogs, AI customer handoffs, and desktop/mobile header navigation.
2. **Prop Drilling**: Global properties (locale, theme, palette, authUser, notices, callbacks) were manually threaded through deeply nested components.
3. **Unstructured Component Directory**: Over 60 component and test files were flatly placed under `web/src/components/` without business domain boundaries.

## Decision

We decoupled the frontend architecture into four distinct layers while preserving 100% API and test compatibility:

```text
┌──────────────────────────────────────────────────────────┐
│                   Next.js App Router                     │
│               (app/page.tsx, app/[...path])              │
└────────────────────────────┬─────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────┐
│                    App.tsx Orchestrator                  │
│              (Declarative Composition Layer)             │
├────────────────────────────┬─────────────────────────────┤
│      Domain Custom Hooks   │    Shell & Layout Layers    │
│  - useAuthSession          │  - PlatformHeader           │
│  - useSubplatformRoute     │  - SubplatformFullscreenHdr │
│  - useOwnedStores          │  - PlatformOverlaysHost     │
│  - useStoreHandoff         │  - PlatformFooter           │
│  - useMarketplaceCatalog   │                             │
├────────────────────────────┴─────────────────────────────┤
│                  Domain Component Modules                │
│  account/  marketplace/  store/  admin/  ui/ (primitives)│
└──────────────────────────────────────────────────────────┘
```

1. **Domain Custom Hooks (`web/src/hooks/`)**:
   - `useAuthSession`: Encapsulates Better Auth session fetching, exponential backoff retries on transient network errors (`408`, `429`, `5xx`), pending authentication guards, root admin authorization, and session cleanup upon signout.
   - `useSubplatformRoute`: Manages route parsing, dynamic subplatform configuration loading, query parameter handling (`?account=`, `?stores=1`, `?console=`, `?publish=1`, `?role=`), and bidirectional URL history synchronization.
   - `useOwnedStores`: Manages user store membership fetching with retries, store console lifecycle, and owner permission checks.
   - `useStoreHandoff`: Handles AI matching contact consent intents, human handoff tickets, and idempotency key generation.
   - `useMarketplaceCatalog`: Handles marketplace catalog loading, liking, and recommendations.

2. **Shell & Overlays Decoupling (`web/src/components/shell/`)**:
   - `PlatformHeader`: Isolates top-level navigation, branding cluster, preference toggles, store entry points, and avatar menu.
   - `SubplatformFullscreenHeader`: Dedicated header for subplatform immersion and plugin hosts.
   - `PlatformOverlaysHost`: Centralizes mounting of 15+ sheets and dialogs (`ListingSheet`, `ModeDialog`, `WorkspaceSettingsDialog`, profile/password/passkey/bindings/stores panels, and toast notices).

3. **Domain Organization & Explicit Imports**:
   - Categorized components by business domains (`account`, `marketplace`, `store`, `admin`, `ui`, `shell`).
   - Import components and hooks from their owning modules. Unconsumed barrel facades are not retained because they obscure dead exports from static analysis; a future public facade must be explicit and exercised by real consumers.

## Consequences

### Positive
- **Maintainability**: `App.tsx` reduced from 1597 lines to ~340 lines of declarative composition.
- **Isolated Testing**: Hooks and UI components can be unit-tested in isolation without mocking the entire application state.
- **Strict Backward Compatibility**: 100% of existing tests (79 test files, 331 tests) continue to pass without modifications.
- **Performance**: Predictable re-renders and faster compilation with Next.js Turbopack.

### Negative
- Developers must follow the designated hook and domain component boundaries rather than adding state directly to `App.tsx`.

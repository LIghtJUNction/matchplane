# Browser WebMCP early preview

MatchPlane exposes a deliberately small set of **client-side, page-scoped browser tools** on the root public marketplace. This is a progressive enhancement for WebMCP-capable browsers, not a universal browser feature and not a new server transport.

Authoritative references checked for this integration:

- [WebMCP draft specification](https://webmachinelearning.github.io/webmcp/)
- [Chrome WebMCP overview](https://developer.chrome.com/docs/ai/webmcp)
- [Chrome imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api)
- [Chrome: WebMCP versus MCP](https://developer.chrome.com/docs/ai/webmcp/compare-mcp)
- [Chrome tool security guidance](https://developer.chrome.com/docs/ai/webmcp/secure-tools)

WebMCP is an early proposal under active change. Chrome documents an origin trial beginning with Chrome 149 and, for local development, the `chrome://flags/#enable-webmcp-testing` flag. A browser-integrated agent or inspector is also required to discover or invoke tools. Unsupported browsers behave exactly as before.

## WebMCP is not `/api/mcp`

The existing `web/app/api/mcp/route.ts` is MatchPlane's backend HTTP MCP endpoint. It remains an HTTP/JSON-RPC boundary for external clients and has its own authentication, request, and tool contract.

This integration instead calls the browser preview API:

```ts
document.modelContext.registerTool(tool, { signal });
```

These tools exist only in the current tab and actuate the already-visible React application. They do not add SSE, stdio, JSON-RPC, or HTTP transport, and they do not mirror the backend MCP tool catalog.

## Capability and lifecycle

Registration occurs only when all of the following are true:

1. the root public marketplace route is active;
2. the document is in a secure context;
3. the document is the top-level browsing context; and
4. `document.modelContext.registerTool` exists.

There is no polyfill, package dependency, browser sniffing, or console output. MatchPlane does not use the removed/deprecated proposal forms `navigator.modelContext`, `provideContext`, `unregisterTool`, or `clearContext`.

Every registration batch shares one `AbortController`. React cleanup aborts its `AbortSignal` when the owning route scope changes or unmounts. Current Chrome documentation notes that aborting registration does not cancel an invocation already in flight. The adapter prevents duplicate names in a batch. Synchronous exceptions and rejected registration promises (including `NotAllowedError` and preview schema incompatibilities) are contained so the human UI continues normally.

The draft `tools` Permissions Policy has a default allowlist of `self`. MatchPlane intentionally relies on that default rather than adding a broader production header. Consequently, cross-origin frames are denied; this preview does not use `exposedTo` or delegate `allow="tools"` to another origin.

## Registered tools

Tool descriptions and outputs are intentionally short. All three tools change visible UI state, so each declares `readOnlyHint: false`.

Tools are available only when their associated visible capability exists. `matchplane.describe_need` is present on the root marketplace. `matchplane.open_listing` is added only when the active category filter renders at least one API-derived listing. `matchplane.open_store` is added only when a store path is represented by those filtered listings, the visible search trace, or a successfully loaded `StorefrontDirectory`; loading, failed, and empty directory states contribute no paths.

### `matchplane.describe_need`

Places text into the visible shopping composer. It does **not** submit the composer, call a model, consume search quota, or claim idempotence. The user can inspect or edit the draft before choosing to submit it.

Description: `Place a bounded public marketplace need in the visible shopping composer for the user to review and submit.`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["narrative"],
  "properties": {
    "narrative": {
      "type": "string",
      "minLength": 1,
      "maxLength": 2000,
      "description": "A public, domain-neutral description of what the user wants to find."
    }
  }
}
```

A successful bounded result is:

```json
{
  "ok": true,
  "action": "need_drafted",
  "character_count": 24,
  "requires_user_submit": true
}
```

The narrative itself is not echoed in the tool result.

### `matchplane.open_store`

Opens a public store represented by a listing that survives the active category filter, the visible search trace, or a successfully loaded `StorefrontDirectory` entry. Runtime code checks exact membership in that current API-derived path union before reusing the page navigation callback.

Description: `Open a public store shown by a filtered listing, visible search trace, or loaded StorefrontDirectory entry.`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["platform_path"],
  "properties": {
    "platform_path": {
      "type": "string",
      "pattern": "^/(?:[a-z0-9-]+(?:/[a-z0-9-]+)*)$",
      "maxLength": 512,
      "description": "The path of a store shown by the filtered listings, search trace, or store directory."
    }
  }
}
```

### `matchplane.open_listing`

Opens the existing detail view for a public API-derived listing that survives the active category filter. Runtime code resolves the exact current filtered listing object before reusing the page callback; listings hidden by the selected category are refused.

Description: `Open the detail view for a public listing shown by the active category filter.`

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["listing_id"],
  "properties": {
    "listing_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 256,
      "description": "The public ID of a listing shown by the active category filter."
    }
  }
}
```

Invalid, extra, oversized, malformed, stale, or invisible inputs produce a bounded structured refusal with `invalid_input` or `not_visible`; they do not invoke the callback.

## User control and consent boundary

The v1 browser tools expose no contact exchange, checkout, payment, seller mutation, marketplace party/profile/behavior write, admin operation, hidden candidate, raw manifest, private attribute, or provider credential. They neither send nor return provider tokens.

Contact retrieval remains behind MatchPlane's existing explicit contact-consent flow and is not a WebMCP capability. The need tool only drafts visible text; user submission remains an explicit UI action. Store and listing tools navigate the same visible interface the user can navigate themselves.

## Manual inspector verification

1. Use a local or otherwise secure top-level MatchPlane page. Do not embed it cross-origin.
2. In the current Chrome preview, open `chrome://flags/#enable-webmcp-testing`, set it to **Enabled**, and relaunch. If testing the origin trial instead, configure the trial according to the current Chrome documentation.
3. Install Chrome's [Model Context Tool Inspector](https://chromewebstore.google.com/detail/model-context-tool-inspec/gbpdfapgefenggkahomfgkhfehlcenpd).
4. Open the root marketplace and open the inspector. Confirm the exact tool names and schemas above. With visible results, each name appears once.
5. Invoke `matchplane.describe_need` with a short narrative. Confirm the visible composer receives the draft and no search starts until the user submits it.
6. Copy a path from the loaded store directory or visible search trace and an ID from the active category's visible listings. Invoke the store and listing tools and confirm the visible page navigates or opens the existing detail view.
7. Try a path absent from the filtered listings, search trace, and loaded directory; a listing hidden by another category; an extra property; and a 2001-Unicode-scalar narrative. Confirm a bounded refusal and no page action.
8. Navigate away from the root marketplace. Confirm the inspector observes the prior registrations disappear through signal abortion.
9. Repeat in an unsupported browser or with the flag disabled. Confirm normal human interaction remains available with no WebMCP errors or console noise.

import type { WebMcpModelContext, WebMcpTool } from "./marketplace-tools";

interface WebMcpEnvironment {
  readonly document?: { readonly modelContext?: WebMcpModelContext };
  readonly secureContext: boolean;
  readonly topLevel: boolean;
}

/**
 * Register one page-scoped batch with one AbortController. Unsupported, embedded,
 * insecure, permission-denied, and draft-schema mismatch cases are silent no-ops.
 */
export function registerWebMcpTools(
  tools: readonly WebMcpTool[],
  environment: WebMcpEnvironment = browserEnvironment(),
): () => void {
  const modelContext = environment.document?.modelContext;
  if (
    !environment.secureContext ||
    !environment.topLevel ||
    !modelContext ||
    typeof modelContext.registerTool !== "function"
  ) {
    return () => undefined;
  }

  const controller = new AbortController();
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) continue;
    names.add(tool.name);
    try {
      void Promise.resolve(
        modelContext.registerTool(tool, { signal: controller.signal }),
      ).catch(() => undefined);
    } catch {
      // Early-preview implementations may reject synchronously. Human UI remains primary.
    }
  }

  return () => controller.abort();
}

function browserEnvironment(): WebMcpEnvironment {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return { secureContext: false, topLevel: false };
  }
  return {
    document,
    secureContext: globalThis.isSecureContext === true,
    topLevel: window.top === window,
  };
}

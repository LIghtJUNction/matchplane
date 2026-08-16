export interface SubplatformConfig {
  slug: string;
  /** Canonical mounted path. The root node is `/`; children may be nested. */
  path: string;
  brandName: string;
  label: string;
  description: string;
  tenantId?: string;
  domainId?: string;
  assetSchemaId?: string;
  currencyScale?: number;
  currency?: string;
  email?: { providerKey?: string; fromAddress?: string };
  /** Optional copy/schema hints owned by the mounted subplatform; root UI remains domain-neutral. */
  ui?: {
    chat?: Record<string, string>;
    filters?: Array<{
      key: string;
      label: string;
      source: "trust" | "price" | "attribute";
      attribute?: string;
      value?: string;
    }>;
    supplyFields?: Array<{
      key: string;
      label: string;
      type?: "text" | "number" | "url" | "date" | "select";
      required?: boolean;
      placeholder?: string;
      options?: string[];
    }>;
  };
  assetSchema?: Record<string, unknown>;
  pluginArtifact?: { entry: string; url: string; digest: string };
  manifestUrl?: string;
}

export function resolveSubplatform(pathname = "/"): SubplatformConfig {
  // Callers often pass a return URL (for example `/?role=buyer`) rather than a
  // bare pathname.  Platform identity is path-scoped, so query/hash material
  // must never become a synthetic child-platform slug.
  const normalizedPath = pathnameOnly(pathname);
  const segments = normalizedPath.split("/").filter(Boolean);
  const path = segments.length ? `/${segments.join("/")}` : "/";
  const slug = segments.at(-1) ?? "root";
  return normalizedPath === "/"
    ? {
        slug: "root",
        path: "/",
        brandName: "MatchPlane",
        label: "通用 AI 撮合",
        description: "把需求交给合适的供给方。",
      }
    : {
        slug,
        path,
        brandName: slug,
        label: "",
        description: "",
        manifestUrl: `/api/platform/manifest?path=${encodeURIComponent(path)}`,
      };
}

function pathnameOnly(value: string): string {
  const candidate = value.trim() || "/";
  try {
    const parsed = new URL(candidate, "https://matchplane.invalid");
    if (parsed.host !== "matchplane.invalid") return "/";
    return parsed.pathname || "/";
  } catch {
    const withoutQuery = candidate.split(/[?#]/, 1)[0] || "/";
    return withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  }
}

/** Load a registered subplatform manifest without embedding vertical data in root. */
export async function loadSubplatform(pathname = "/"): Promise<SubplatformConfig> {
  const base = resolveSubplatform(pathname);
  if (!base.manifestUrl) return base;
  try {
    const response = await fetch(base.manifestUrl, { headers: { accept: "application/json" } });
    if (!response.ok) return base;
    const manifest = (await response.json()) as {
      displayName?: string;
      description?: string;
      label?: string;
      tenantId?: string;
      domainId?: string;
      assetSchemaId?: string;
      currencyScale?: number;
      currency?: string;
      email?: { providerKey?: string; fromAddress?: string };
      ui?: {
        chat?: Record<string, string>;
        filters?: NonNullable<SubplatformConfig["ui"]>["filters"];
        supplyFields?: NonNullable<SubplatformConfig["ui"]>["supplyFields"];
      };
      assetSchema?: Record<string, unknown>;
      assets?: {
        hosted?: { entry?: string; url?: string; digest?: string };
      };
    };
    return {
      ...base,
      // The URL/database registration is the canonical mount. A package manifest may describe
      // its own route for validation, but it cannot rewrite the path that authenticated API
      // calls and capability scopes use.
      path: base.path,
      brandName: manifest.displayName?.trim() || base.brandName,
      label: manifest.label?.trim() || manifest.displayName?.trim() || base.label,
      description: manifest.description?.trim() || base.description,
      tenantId: manifest.tenantId,
      domainId: manifest.domainId,
      assetSchemaId: manifest.assetSchemaId,
      currencyScale: Number.isInteger(manifest.currencyScale) ? manifest.currencyScale : undefined,
      currency: manifest.currency?.trim() || undefined,
      email: manifest.email,
      ui: validUi(manifest.ui),
      assetSchema: validAssetSchema(manifest.assetSchema),
      pluginArtifact: validHostedArtifact(manifest.assets?.hosted),
    };
  } catch {
    return base;
  }
}

function validUi(value: SubplatformConfig["ui"] | undefined): SubplatformConfig["ui"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const chat = value.chat && typeof value.chat === "object"
    ? Object.fromEntries(Object.entries(value.chat).filter(([key, item]) => /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) && typeof item === "string" && item.length <= 500))
    : undefined;
  const filters = Array.isArray(value.filters)
    ? value.filters.filter((filter) => filter && typeof filter.key === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(filter.key)
      && typeof filter.label === "string" && filter.label.length <= 200
      && (filter.source === "trust" || filter.source === "price" || filter.source === "attribute")
      && (!filter.attribute || /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(filter.attribute))
      && (!filter.value || typeof filter.value === "string" && filter.value.length <= 200))
      .slice(0, 32)
    : undefined;
  const supplyFields = Array.isArray(value.supplyFields)
    ? value.supplyFields.filter((field) => field && typeof field.key === "string" && /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(field.key)
      && typeof field.label === "string" && field.label.length <= 200
      && (!field.options || (Array.isArray(field.options) && field.options.every((option) => typeof option === "string" && option.length <= 200))))
      .slice(0, 64)
    : undefined;
  if (!chat && !filters?.length && !supplyFields?.length) return undefined;
  return {
    ...(chat ? { chat } : {}),
    ...(filters?.length ? { filters } : {}),
    ...(supplyFields?.length ? { supplyFields } : {}),
  };
}

function validAssetSchema(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    return JSON.stringify(value).length <= 64_000 ? value : undefined;
  } catch {
    return undefined;
  }
}

function validHostedArtifact(
  value: { entry?: string; url?: string; digest?: string } | undefined,
): SubplatformConfig["pluginArtifact"] {
  if (!value || !value.entry || !value.url || !value.digest) return undefined;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/.test(value.entry)) return undefined;
  if (!/^\/api\/platform\/plugin-assets\//.test(value.url)) return undefined;
  if (!/^[0-9a-f]{64}$/i.test(value.digest)) return undefined;
  return { entry: value.entry, url: value.url, digest: value.digest };
}

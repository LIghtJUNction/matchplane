import type { InterfaceLocale } from "./lib/preferences";

export type PricingMode = "fixed" | "range" | "negotiable" | "none";

export interface PricingConfig {
  mode: PricingMode;
  currency?: string;
  currencyScale?: number;
  label?: string;
}

export interface ChatUiConfig {
  /** Optional headline copy owned by the mounted platform package. */
  buyerHeadlines?: string[];
  sellerHeadlines?: string[];
  /** Root-home typewriter phrases configured by the mall operator. */
  homePlaceholderPhrases?: string[];
  /** Initial consent choice for contact-free supply discovery. */
  demandDiscoveryDefault?: boolean;
  listingEyebrow?: string;
  listingLabel?: string;
  [key: string]: string | string[] | boolean | undefined;
}

/**
 * Selects the stable marketplace transport owned by the mounted package.
 *
 * The generic contract is the default and is intentionally independent of a
 * vertical's field names, prices, or role labels.  `legacy-v1` is an explicit
 * compatibility escape hatch for packages that still need the pre-generic
 * adapter; it must never be inferred from pricing or a schema.
 */
export type MarketplaceContract = "generic-v1" | "legacy-v1";

export interface SubplatformConfig {
  slug: string;
  /** Canonical mounted path. The root node is `/`; children may be nested. */
  path: string;
  brandName: string;
  /** Public mall logo. Store packages keep their own visual identity. */
  brandLogoUrl?: string;
  label: string;
  description: string;
  status?: "active" | "closed" | "pending" | "suspended";
  /** Better Auth organization id for an active child; supplied by the root manifest endpoint. */
  organizationId?: string;
  tenantId?: string;
  domainId?: string;
  assetSchemaId?: string;
  currencyScale?: number;
  currency?: string;
  /** Pricing is a subplatform capability; absent means the offer is not fixed-price. */
  pricing?: PricingConfig;
  marketplaceContract?: MarketplaceContract;
  email?: { providerKey?: string; fromAddress?: string };
  /** Optional copy/schema hints owned by the mounted subplatform; root UI remains domain-neutral. */
  ui?: {
    chat?: ChatUiConfig;
    /** Human-facing labels are supplied by the mounted package, not inferred by the root. */
    copy?: Record<string, string>;
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
  /** Capability names exposed by the package's authenticated Agent/MCP server. */
  agentMcpTools?: string[];
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
        label: "通用撮合",
        description: "把需求交给合适的供给方。",
        pricing: { mode: "none" },
        marketplaceContract: "generic-v1",
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
export async function loadSubplatform(
  pathname = "/",
): Promise<SubplatformConfig> {
  const base = resolveSubplatform(pathname);
  if (!base.manifestUrl) {
    // The public shell needs only the mall's display name. Operational setup state and database
    // identifiers remain behind the authenticated mall console.
    try {
      const response = await fetch("/api/mall/settings", {
        headers: { accept: "application/json" },
      });
      if (!response.ok) return base;
      const body = (await response.json()) as {
        mall?: {
          name?: unknown;
          logoUrl?: unknown;
          placeholderPhrases?: unknown;
        } | null;
      };
      const name = body.mall?.name;
      const brandLogoUrl =
        typeof body.mall?.logoUrl === "string" &&
        body.mall.logoUrl.startsWith("/api/mall/logo")
          ? body.mall.logoUrl
          : undefined;
      const homePlaceholderPhrases = Array.isArray(
        body.mall?.placeholderPhrases,
      )
        ? body.mall.placeholderPhrases.filter(
            (phrase): phrase is string =>
              typeof phrase === "string" && phrase.trim().length > 0,
          )
        : [];
      const brandName =
        typeof name === "string" && name.trim() ? name.trim() : base.brandName;
      return {
        ...base,
        brandName,
        label: brandName,
        brandLogoUrl,
        ui: homePlaceholderPhrases.length
          ? {
              ...base.ui,
              chat: {
                ...base.ui?.chat,
                homePlaceholderPhrases,
              },
            }
          : base.ui,
      };
    } catch {
      return base;
    }
  }
  try {
    // pi-lens-ignore: ts-ssrf
    const response = await fetch(base.manifestUrl, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return base;
    const manifest = (await response.json()) as {
      displayName?: string;
      description?: string;
      label?: string;
      status?: string;
      tenantId?: string;
      domainId?: string;
      organizationId?: string;
      assetSchemaId?: string;
      currencyScale?: number;
      currency?: string;
      pricing?: PricingConfig;
      marketplaceContract?: MarketplaceContract;
      email?: { providerKey?: string; fromAddress?: string };
      ui?: {
        chat?: ChatUiConfig;
        copy?: Record<string, string>;
        filters?: NonNullable<SubplatformConfig["ui"]>["filters"];
        supplyFields?: NonNullable<SubplatformConfig["ui"]>["supplyFields"];
      };
      assetSchema?: Record<string, unknown>;
      agent?: { mcpTools?: unknown };
      assets?: {
        hosted?: { entry?: string; url?: string; digest?: string };
      };
    };
    const pricing =
      validPricing(manifest.pricing) ??
      (manifest.currency?.trim()
        ? {
            mode: "fixed" as const,
            currency: manifest.currency.trim(),
            currencyScale: manifest.currencyScale,
          }
        : { mode: "none" as const });
    return {
      ...base,
      // The URL/database registration is the canonical mount. A package manifest may describe
      // its own route for validation, but it cannot rewrite the path that authenticated API
      // calls and capability scopes use.
      path: base.path,
      brandName: manifest.displayName?.trim() || base.brandName,
      label:
        manifest.label?.trim() || manifest.displayName?.trim() || base.label,
      description: manifest.description?.trim() || base.description,
      status:
        (manifest.status as SubplatformConfig["status"]) ||
        (base.slug === "root" ? "active" : undefined),
      tenantId: manifest.tenantId,
      domainId: manifest.domainId,
      organizationId: manifest.organizationId,
      assetSchemaId: manifest.assetSchemaId,
      currencyScale: Number.isInteger(manifest.currencyScale)
        ? manifest.currencyScale
        : undefined,
      currency: manifest.currency?.trim() || undefined,
      pricing,
      marketplaceContract:
        manifest.marketplaceContract === "legacy-v1"
          ? "legacy-v1"
          : "generic-v1",
      email: manifest.email,
      ui: validUi(manifest.ui),
      assetSchema: validAssetSchema(manifest.assetSchema),
      agentMcpTools: validMcpTools(manifest.agent?.mcpTools),
      pluginArtifact: validHostedArtifact(manifest.assets?.hosted),
    };
  } catch {
    return base;
  }
}

function validMcpTools(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (tool): tool is string =>
        typeof tool === "string" && /^[a-z0-9][a-z0-9._:-]{1,127}$/.test(tool),
    )
    .slice(0, 64);
}

export function pricingFor(subplatform: SubplatformConfig): PricingConfig {
  if (subplatform.pricing) return subplatform.pricing;
  if (subplatform.currency?.trim()) {
    return {
      mode: "fixed",
      currency: subplatform.currency.trim(),
      currencyScale: subplatform.currencyScale,
    };
  }
  return { mode: "none" };
}

/** Resolve a bounded package-owned label with a root-owned generic fallback. */
export function subplatformCopy(
  subplatform: SubplatformConfig,
  key: string,
  fallback: string,
): string {
  const value = subplatform.ui?.copy?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function subplatformFieldValue(
  key: string,
  value: unknown,
  locale: InterfaceLocale = "zh",
): string {
  if (typeof value === "boolean")
    return value
      ? locale === "en"
        ? "Yes"
        : "是"
      : locale === "en"
        ? "No"
        : "否";
  if (key === "delivery_mode" && typeof value === "string") {
    const labels =
      locale === "en"
        ? {
            shipping: "Shipping",
            local_pickup: "Local pickup",
            digital: "Digital delivery",
            mixed: "Shipping or pickup",
          }
        : {
            shipping: "快递寄送",
            local_pickup: "到店自取",
            digital: "线上交付",
            mixed: "快递或自取",
          };
    if (value in labels) return labels[value as keyof typeof labels];
  }
  if (key === "condition" && typeof value === "string") {
    const labels =
      locale === "en"
        ? { new: "New", used: "Used", refurbished: "Refurbished" }
        : { new: "全新", used: "二手", refurbished: "翻新" };
    if (value in labels) return labels[value as keyof typeof labels];
  }
  return String(value);
}

/** Resolve a human label for a schema attribute without exposing machine keys in the UI. */
export function subplatformFieldLabel(
  subplatform: SubplatformConfig,
  key: string,
  locale: InterfaceLocale = "zh",
): string {
  const configured = subplatform.ui?.supplyFields?.find(
    (field) => field.key === key,
  )?.label;
  if (configured?.trim()) return configured.trim();
  const properties = subplatform.assetSchema?.properties;
  if (
    properties &&
    typeof properties === "object" &&
    !Array.isArray(properties)
  ) {
    const descriptor = (properties as Record<string, unknown>)[key];
    if (
      descriptor &&
      typeof descriptor === "object" &&
      !Array.isArray(descriptor)
    ) {
      const title = (descriptor as { title?: unknown }).title;
      if (typeof title === "string" && title.trim()) return title.trim();
    }
  }
  const generic =
    locale === "en"
      ? {
          category: "Category",
          delivery_mode: "Delivery",
          stock_quantity: "Available stock",
          condition: "Condition",
          location: "Location",
          verified: "Verified",
        }
      : {
          category: "商品分类",
          delivery_mode: "交付方式",
          stock_quantity: "可售库存",
          condition: "商品状况",
          location: "所在地区",
          verified: "已核验",
        };
  if (key in generic) return generic[key as keyof typeof generic];
  return key
    .replace(/[_.-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/** Resolve labels for contact values released by the platform consent flow. */
export function subplatformContactLabel(
  _subplatform: SubplatformConfig,
  key: string,
): string {
  return key === "email" ? "邮箱" : key === "phone" ? "手机号" : key;
}

function validPricing(
  value: PricingConfig | undefined,
): PricingConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const mode = value.mode;
  if (
    mode !== "fixed" &&
    mode !== "range" &&
    mode !== "negotiable" &&
    mode !== "none"
  )
    return undefined;
  const currency =
    typeof value.currency === "string" &&
    /^[A-Z]{3}$/.test(value.currency.trim().toUpperCase())
      ? value.currency.trim().toUpperCase()
      : undefined;
  const currencyScale =
    typeof value.currencyScale === "number" &&
    Number.isInteger(value.currencyScale) &&
    value.currencyScale >= 0 &&
    value.currencyScale <= 18
      ? value.currencyScale
      : undefined;
  const label =
    typeof value.label === "string" && value.label.trim().length <= 120
      ? value.label.trim()
      : undefined;
  return {
    mode,
    ...(currency ? { currency } : {}),
    ...(currencyScale !== undefined ? { currencyScale } : {}),
    ...(label ? { label } : {}),
  };
}

function validUi(
  value: SubplatformConfig["ui"] | undefined,
): SubplatformConfig["ui"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const chat =
    value.chat && typeof value.chat === "object"
      ? (() => {
          const entries: Array<[string, string | string[] | boolean]> = [];
          for (const [key, item] of Object.entries(value.chat)) {
            if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key)) continue;
            if (key === "demandDiscoveryDefault" && typeof item === "boolean") {
              entries.push([key, item]);
              continue;
            }
            if (typeof item === "string" && item.length <= 500) {
              entries.push([key, item]);
              continue;
            }
            if (
              key === "buyerHeadlines" ||
              key === "sellerHeadlines" ||
              key === "buyerHeadlinesEn" ||
              key === "sellerHeadlinesEn"
            ) {
              if (!Array.isArray(item)) continue;
              const headlines = item
                .filter(
                  (headline): headline is string =>
                    typeof headline === "string" &&
                    headline.trim().length > 0 &&
                    headline.length <= 160,
                )
                .map((headline) => headline.trim())
                .slice(0, 12);
              if (headlines.length) entries.push([key, headlines]);
            }
          }
          return Object.fromEntries(entries) as ChatUiConfig;
        })()
      : undefined;
  const copy =
    value.copy && typeof value.copy === "object"
      ? Object.fromEntries(
          Object.entries(value.copy).filter(
            ([key, item]) =>
              /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) &&
              typeof item === "string" &&
              item.length <= 500,
          ),
        )
      : undefined;
  const filters = Array.isArray(value.filters)
    ? value.filters
        .filter(
          (filter) =>
            filter &&
            typeof filter.key === "string" &&
            /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(filter.key) &&
            typeof filter.label === "string" &&
            filter.label.length <= 200 &&
            (filter.source === "trust" ||
              filter.source === "price" ||
              filter.source === "attribute") &&
            (!filter.attribute ||
              /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(filter.attribute)) &&
            (!filter.value ||
              (typeof filter.value === "string" && filter.value.length <= 200)),
        )
        .slice(0, 32)
    : undefined;
  const supplyFields = Array.isArray(value.supplyFields)
    ? value.supplyFields
        .filter(
          (field) =>
            field &&
            typeof field.key === "string" &&
            /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/.test(field.key) &&
            typeof field.label === "string" &&
            field.label.length <= 200 &&
            (!field.options ||
              (Array.isArray(field.options) &&
                field.options.every(
                  (option) =>
                    typeof option === "string" && option.length <= 200,
                ))),
        )
        .slice(0, 64)
    : undefined;
  if (!chat && !copy && !filters?.length && !supplyFields?.length)
    return undefined;
  return {
    ...(chat ? { chat } : {}),
    ...(copy ? { copy } : {}),
    ...(filters?.length ? { filters } : {}),
    ...(supplyFields?.length ? { supplyFields } : {}),
  };
}

function validAssetSchema(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
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
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/.test(value.entry))
    return undefined;
  if (!/^\/api\/platform\/plugin-assets\//.test(value.url)) return undefined;
  if (!/^[0-9a-f]{64}$/i.test(value.digest)) return undefined;
  return { entry: value.entry, url: value.url, digest: value.digest };
}

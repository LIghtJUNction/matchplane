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
  return slug === "root"
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
      assets?: {
        hosted?: { entry?: string; url?: string; digest?: string };
      };
      routes?: string[];
    };
    const declaredRoute = validRoute(manifest.routes?.[0]);
    const mountedRoute = declaredRoute && routeBelongsToMount(declaredRoute, base.path)
      ? declaredRoute
      : base.path;
    return {
      ...base,
      path: mountedRoute,
      brandName: manifest.displayName?.trim() || base.brandName,
      label: manifest.label?.trim() || manifest.displayName?.trim() || base.label,
      description: manifest.description?.trim() || base.description,
      tenantId: manifest.tenantId,
      domainId: manifest.domainId,
      assetSchemaId: manifest.assetSchemaId,
      currencyScale: Number.isInteger(manifest.currencyScale) ? manifest.currencyScale : undefined,
      currency: manifest.currency?.trim() || undefined,
      email: manifest.email,
      pluginArtifact: validHostedArtifact(manifest.assets?.hosted),
    };
  } catch {
    return base;
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

function validRoute(value: string | undefined): string | undefined {
  return value && /^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(value) ? value : undefined;
}

function routeBelongsToMount(route: string, mount: string): boolean {
  return mount === "/" || route === mount || route.startsWith(`${mount}/`);
}

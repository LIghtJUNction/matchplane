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
  manifestUrl?: string;
}

export function resolveSubplatform(pathname = "/"): SubplatformConfig {
  const segments = pathname.split("/").filter(Boolean);
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
        manifestUrl: segments.length === 1
          ? `${path}/matchplane.subplatform.json`
          : `/api/platform/manifest?path=${encodeURIComponent(path)}`,
      };
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
    };
  } catch {
    return base;
  }
}

function validRoute(value: string | undefined): string | undefined {
  return value && /^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(value) ? value : undefined;
}

function routeBelongsToMount(route: string, mount: string): boolean {
  return mount === "/" || route === mount || route.startsWith(`${mount}/`);
}

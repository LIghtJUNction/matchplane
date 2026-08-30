import { createHash } from "node:crypto";

import {
  MAX_PRODUCT_TEMPLATES,
  PRODUCT_TEMPLATE_ID_PATTERN,
} from "../product-templates";
import type { StoreAccessRow } from "./store-access";

const CATALOG_REVISION = /^[a-f0-9]{64}$/;

export interface ProductTemplateSettings {
  enabledTemplateIds: string[];
  defaultTemplateId: string | null;
}

export interface ProductTemplateCatalog<TTemplate = { id: string }> {
  revision: string;
  registrationId: string | null;
  templates: TTemplate[];
  defaultTemplateId: string | null;
}

export interface ProductTemplateSettingsUpdate extends ProductTemplateSettings {
  expectedStoreVersion: number;
  expectedCatalogRevision: string;
}

export type ProductTemplateSettingsUpdateResult =
  | { ok: true; value: ProductTemplateSettingsUpdate }
  | { ok: false; error: string };

/**
 * Build a stable catalog identity from the manifest content rather than a process-local value.
 * JSONB does not preserve object key order, so keys are sorted before hashing.
 */
export function createProductTemplateCatalog<TTemplate extends { id: string }>(
  manifest: unknown,
  registrationId: string | null,
  templates: TTemplate[],
  defaultTemplateId: string | null,
): ProductTemplateCatalog<TTemplate> {
  return {
    revision: createHash("sha256").update(stableJson(manifest)).digest("hex"),
    registrationId,
    templates,
    defaultTemplateId,
  };
}

/** A hosted store has no registration row, but still needs a deterministic manifest identity. */
export function synthesizeHostedStoreManifest(
  store: Pick<
    StoreAccessRow,
    | "id"
    | "slug"
    | "path"
    | "displayName"
    | "description"
    | "status"
    | "organizationId"
    | "tenantId"
    | "domainId"
    | "version"
  >,
): Record<string, unknown> {
  return {
    apiVersion: "matchplane.subplatform/v1",
    id: `hosted.${store.id}`,
    slug: store.slug,
    displayName: store.displayName,
    description: store.description,
    status: store.status,
    marketplaceContract: "generic-v1",
    pricing: {
      mode: "fixed",
      currency: "CNY",
      currencyScale: 2,
      label: "价格",
    },
    rootApiVersion: "v1",
    routes: [store.path],
    capabilities: ["demand", "supply", "public_catalog"],
    requiredScopes: ["marketplace:read", "marketplace:write"],
    organizationId: store.organizationId,
    tenantId: store.tenantId,
    domainId: store.domainId,
    version: Number(store.version),
  };
}

/**
 * Missing settings opt in to the complete current catalog. A malformed or stale saved record is
 * never treated as missing: it fails closed so catalog drift cannot silently enable products.
 */
export function resolveProductTemplateSettings(
  metadata: unknown,
  catalog: Pick<ProductTemplateCatalog, "templates" | "defaultTemplateId">,
): ProductTemplateSettings {
  const catalogIds = catalog.templates.map((template) => template.id);
  const fallback = {
    enabledTemplateIds: [...catalogIds],
    defaultTemplateId: catalogIds.length ? catalog.defaultTemplateId : null,
  };
  const metadataRecord = record(metadata);
  if (!("product_templates" in metadataRecord)) return fallback;

  const stored = record(metadataRecord.product_templates);
  if (
    stored.schema_version !== 1 ||
    !Array.isArray(stored.enabled_template_ids) ||
    !stored.enabled_template_ids.every(
      (id) => typeof id === "string" && PRODUCT_TEMPLATE_ID_PATTERN.test(id),
    ) ||
    new Set(stored.enabled_template_ids).size !==
      stored.enabled_template_ids.length ||
    stored.enabled_template_ids.length > MAX_PRODUCT_TEMPLATES ||
    (stored.default_template_id !== null &&
      typeof stored.default_template_id !== "string")
  ) {
    return { enabledTemplateIds: [], defaultTemplateId: null };
  }

  const available = new Set(catalogIds);
  const enabledTemplateIds = stored.enabled_template_ids.filter((id) =>
    available.has(id),
  ) as string[];
  if (enabledTemplateIds.length === 0) {
    return { enabledTemplateIds: [], defaultTemplateId: null };
  }
  const defaultTemplateId = stored.default_template_id;
  if (
    typeof defaultTemplateId !== "string" ||
    !enabledTemplateIds.includes(defaultTemplateId)
  ) {
    return { enabledTemplateIds: [], defaultTemplateId: null };
  }
  return { enabledTemplateIds, defaultTemplateId };
}

export function parseProductTemplateSettingsUpdate(
  input: unknown,
): ProductTemplateSettingsUpdateResult {
  const body = record(input);
  const enabledTemplateIds = body.enabledTemplateIds;
  const defaultTemplateId = body.defaultTemplateId;
  const expectedStoreVersion = body.expectedStoreVersion;
  const expectedCatalogRevision = body.expectedCatalogRevision;

  if (
    !Array.isArray(enabledTemplateIds) ||
    enabledTemplateIds.length > MAX_PRODUCT_TEMPLATES ||
    !enabledTemplateIds.every(
      (id) => typeof id === "string" && PRODUCT_TEMPLATE_ID_PATTERN.test(id),
    ) ||
    new Set(enabledTemplateIds).size !== enabledTemplateIds.length
  ) {
    return { ok: false, error: "启用的商品模板列表无效" };
  }
  if (enabledTemplateIds.length === 0) {
    if (defaultTemplateId !== null) {
      return { ok: false, error: "停用全部商品模板时默认模板必须为空" };
    }
  } else if (
    typeof defaultTemplateId !== "string" ||
    !enabledTemplateIds.includes(defaultTemplateId)
  ) {
    return { ok: false, error: "默认商品模板必须是已启用的模板" };
  }
  if (
    !Number.isSafeInteger(expectedStoreVersion) ||
    Number(expectedStoreVersion) < 1
  ) {
    return { ok: false, error: "店铺版本无效，请刷新后重试" };
  }
  if (
    typeof expectedCatalogRevision !== "string" ||
    !CATALOG_REVISION.test(expectedCatalogRevision)
  ) {
    return { ok: false, error: "商品模板目录版本无效，请刷新后重试" };
  }

  return {
    ok: true,
    value: {
      enabledTemplateIds: enabledTemplateIds as string[],
      defaultTemplateId: defaultTemplateId as string | null,
      expectedStoreVersion: Number(expectedStoreVersion),
      expectedCatalogRevision,
    },
  };
}

export function validateProductTemplateSettingsCatalog(
  settings: ProductTemplateSettings,
  catalog: Pick<ProductTemplateCatalog, "templates">,
): string | null {
  const catalogIds = new Set(catalog.templates.map((template) => template.id));
  return settings.enabledTemplateIds.every((id) => catalogIds.has(id))
    ? null
    : "启用列表包含当前目录中不存在的商品模板";
}

export function storedProductTemplateSettings(
  settings: ProductTemplateSettings,
): Record<string, unknown> {
  return {
    schema_version: 1,
    enabled_template_ids: settings.enabledTemplateIds,
    default_template_id: settings.defaultTemplateId,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "null" : serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

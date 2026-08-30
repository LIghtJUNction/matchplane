import { isSafePublicAttributeKey } from "./storefront-ranking-shared";
import type { SupplyFieldConfig, SupplyFieldType } from "./subplatform";

export const MAX_PRODUCT_TEMPLATES = 16;
export const MAX_PRODUCT_TEMPLATE_FIELDS = 64;
export const MAX_PRODUCT_TEMPLATE_FIELD_DECLARATIONS = 256;
export const MAX_PRODUCT_TEMPLATE_DISTINCT_FIELD_KEYS = 128;
export const MAX_PRODUCT_TEMPLATE_DESCRIPTION_LENGTH = 1_000;

export const PRODUCT_TEMPLATE_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

const ATTRIBUTE_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;
const SUPPLY_NUMBER_LIMIT = 1_000_000_000_000_000;
const SUPPLY_FIELD_TYPES = new Set<SupplyFieldType>([
  "text",
  "textarea",
  "number",
  "url",
  "date",
  "select",
]);
const SUPPLY_FIELD_KEYS = new Set([
  "key",
  "label",
  "type",
  "required",
  "placeholder",
  "options",
  "group",
  "help",
  "unit",
  "min",
  "max",
  "step",
]);
const PRODUCT_TEMPLATE_KEYS = new Set([
  "id",
  "label",
  "description",
  "category",
  "supplyFields",
]);

export interface ProductTemplateConfig {
  id: string;
  label: string;
  description?: string;
  category?: string;
  supplyFields: SupplyFieldConfig[];
}

export interface ProductTemplateCatalog {
  productTemplates: ProductTemplateConfig[];
  defaultProductTemplateId?: string;
}

export interface ProductTemplateSwitchImpact {
  keptKeys: string[];
  addedKeys: string[];
  removedKeys: string[];
  changedKeys: string[];
  newlyRequiredKeys: string[];
}

/** Parse and normalize one bounded list of public supply-field declarations. */
export function parseSupplyFields(
  value: unknown,
  maximum = MAX_PRODUCT_TEMPLATE_FIELDS,
): SupplyFieldConfig[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const fields: SupplyFieldConfig[] = [];
  const keys = new Set<string>();
  for (const valueField of value) {
    const field = parseSupplyField(valueField);
    if (!field || keys.has(field.key)) return null;
    keys.add(field.key);
    fields.push(field);
  }
  return fields;
}

/** Parse a product-template array and enforce catalog-wide declaration limits. */
export function parseProductTemplates(
  value: unknown,
): ProductTemplateConfig[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_PRODUCT_TEMPLATES
  ) {
    return null;
  }

  const templates: ProductTemplateConfig[] = [];
  const templateIds = new Set<string>();
  const definitions = new Map<string, SupplyFieldConfig>();
  let declarationCount = 0;

  for (const rawTemplate of value) {
    const template = parseProductTemplate(rawTemplate);
    if (!template || templateIds.has(template.id)) return null;
    templateIds.add(template.id);
    declarationCount += template.supplyFields.length;
    if (declarationCount > MAX_PRODUCT_TEMPLATE_FIELD_DECLARATIONS) return null;

    for (const field of template.supplyFields) {
      const previous = definitions.get(field.key);
      if (previous && !supplyFieldDefinitionsEqual(previous, field))
        return null;
      definitions.set(field.key, field);
      if (definitions.size > MAX_PRODUCT_TEMPLATE_DISTINCT_FIELD_KEYS)
        return null;
    }
    templates.push(template);
  }

  return templates;
}

/**
 * Parse the top-level manifest template contract. Legacy `ui.supplyFields` is
 * accepted only when no product-template catalog is declared.
 */
export function parseProductTemplateCatalog(
  value: unknown,
): ProductTemplateCatalog | null {
  if (!isRecord(value)) return null;
  const hasProductTemplates = Object.hasOwn(value, "productTemplates");
  const hasLegacyFields =
    isRecord(value.ui) && Object.hasOwn(value.ui, "supplyFields");

  if (!hasProductTemplates) {
    if (value.defaultProductTemplateId !== undefined) return null;
    return { productTemplates: [] };
  }
  if (hasLegacyFields) return null;

  const productTemplates = parseProductTemplates(value.productTemplates);
  if (!productTemplates) return null;

  const defaultProductTemplateId = value.defaultProductTemplateId;
  if (
    defaultProductTemplateId !== undefined &&
    (typeof defaultProductTemplateId !== "string" ||
      !PRODUCT_TEMPLATE_ID_PATTERN.test(defaultProductTemplateId) ||
      !productTemplates.some(
        (template) => template.id === defaultProductTemplateId,
      ))
  ) {
    return null;
  }
  if (productTemplates.length > 1 && defaultProductTemplateId === undefined)
    return null;

  return defaultProductTemplateId === undefined
    ? { productTemplates }
    : { productTemplates, defaultProductTemplateId };
}

export function defaultProductTemplate(
  catalog: ProductTemplateCatalog,
): ProductTemplateConfig | null {
  if (catalog.defaultProductTemplateId) {
    return (
      catalog.productTemplates.find(
        (template) => template.id === catalog.defaultProductTemplateId,
      ) ?? null
    );
  }
  return catalog.productTemplates.length === 1
    ? (catalog.productTemplates[0] ?? null)
    : null;
}

/** Resolve only an explicitly bound template ID; unknown IDs never fall back. */
export function supplyFieldsForProductTemplate(
  catalog: Pick<ProductTemplateCatalog, "productTemplates">,
  productTemplateId: string,
): SupplyFieldConfig[] | null {
  return (
    catalog.productTemplates.find(
      (template) => template.id === productTemplateId,
    )?.supplyFields ?? null
  );
}

/** Compare semantic field definitions after applying optional defaults. */
export function supplyFieldDefinitionsEqual(
  left: SupplyFieldConfig,
  right: SupplyFieldConfig,
): boolean {
  return (
    JSON.stringify(comparableSupplyField(left)) ===
    JSON.stringify(comparableSupplyField(right))
  );
}

/** Describe which attribute values can survive a template change. */
export function productTemplateSwitchImpact(
  fromFields: readonly SupplyFieldConfig[],
  toFields: readonly SupplyFieldConfig[],
): ProductTemplateSwitchImpact {
  const from = new Map(fromFields.map((field) => [field.key, field]));
  const to = new Map(toFields.map((field) => [field.key, field]));
  const keptKeys: string[] = [];
  const changedKeys: string[] = [];
  const removedKeys = fromFields
    .filter((field) => !to.has(field.key))
    .map((field) => field.key);
  const addedKeys = toFields
    .filter((field) => !from.has(field.key))
    .map((field) => field.key);

  for (const field of toFields) {
    const previous = from.get(field.key);
    if (!previous) continue;
    if (supplyFieldDefinitionsEqual(previous, field)) keptKeys.push(field.key);
    else changedKeys.push(field.key);
  }

  return {
    keptKeys,
    addedKeys,
    removedKeys,
    changedKeys,
    newlyRequiredKeys: toFields
      .filter(
        (field) =>
          field.required === true && from.get(field.key)?.required !== true,
      )
      .map((field) => field.key),
  };
}

function parseProductTemplate(value: unknown): ProductTemplateConfig | null {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !PRODUCT_TEMPLATE_KEYS.has(key)) ||
    typeof value.id !== "string" ||
    !PRODUCT_TEMPLATE_ID_PATTERN.test(value.id)
  ) {
    return null;
  }
  const label = normalizedRequiredString(value.label, 200);
  const description = normalizedOptionalString(
    value.description,
    MAX_PRODUCT_TEMPLATE_DESCRIPTION_LENGTH,
  );
  const category = normalizedOptionalString(value.category, 120);
  const supplyFields = parseSupplyFields(value.supplyFields);
  if (!label || description === null || category === null || !supplyFields)
    return null;

  return {
    id: value.id,
    label,
    ...(description === undefined ? {} : { description }),
    ...(category === undefined ? {} : { category }),
    supplyFields,
  };
}

function parseSupplyField(value: unknown): SupplyFieldConfig | null {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !SUPPLY_FIELD_KEYS.has(key)) ||
    typeof value.key !== "string" ||
    !ATTRIBUTE_KEY_PATTERN.test(value.key) ||
    !isSafePublicAttributeKey(value.key)
  ) {
    return null;
  }
  const label = normalizedRequiredString(value.label, 200);
  const placeholder = normalizedOptionalString(value.placeholder, 500, true);
  const group = normalizedOptionalString(value.group, 120);
  const help = normalizedOptionalString(value.help, 500);
  const unit = normalizedOptionalString(value.unit, 40);
  if (
    !label ||
    placeholder === null ||
    group === null ||
    help === null ||
    unit === null ||
    (value.type !== undefined &&
      (typeof value.type !== "string" ||
        !SUPPLY_FIELD_TYPES.has(value.type as SupplyFieldType))) ||
    (value.required !== undefined && typeof value.required !== "boolean")
  ) {
    return null;
  }

  const type = value.type as SupplyFieldType | undefined;
  const min = supplyNumber(value.min);
  const max = supplyNumber(value.max);
  const step = supplyNumber(value.step);
  if (
    min === null ||
    max === null ||
    step === null ||
    (step !== undefined && step <= 0) ||
    (min !== undefined && max !== undefined && min > max) ||
    ((min !== undefined || max !== undefined || step !== undefined) &&
      type !== "number")
  ) {
    return null;
  }

  let options: string[] | undefined;
  if (value.options !== undefined) {
    if (!Array.isArray(value.options) || value.options.length > 64) return null;
    options = [];
    const seen = new Set<string>();
    for (const option of value.options) {
      const normalized = normalizedRequiredString(option, 200);
      if (!normalized || seen.has(normalized)) return null;
      seen.add(normalized);
      options.push(normalized);
    }
  }
  if ((type === "select" && !options?.length) || (options && type !== "select"))
    return null;

  return {
    key: value.key,
    label,
    ...(type === undefined ? {} : { type }),
    ...(value.required === undefined ? {} : { required: value.required }),
    ...(placeholder === undefined ? {} : { placeholder }),
    ...(options === undefined ? {} : { options }),
    ...(group === undefined ? {} : { group }),
    ...(help === undefined ? {} : { help }),
    ...(unit === undefined ? {} : { unit }),
    ...(min === undefined ? {} : { min }),
    ...(max === undefined ? {} : { max }),
    ...(step === undefined ? {} : { step }),
  };
}

function comparableSupplyField(
  field: SupplyFieldConfig,
): Record<string, unknown> {
  return {
    key: field.key,
    label: field.label.trim(),
    type: field.type ?? "text",
    required: field.required ?? false,
    placeholder: field.placeholder?.trim(),
    options: field.options?.map((option) => option.trim()),
    group: field.group?.trim(),
    help: field.help?.trim(),
    unit: field.unit?.trim(),
    min: field.min,
    max: field.max,
    step: field.step,
  };
}

function normalizedRequiredString(
  value: unknown,
  maximum: number,
): string | null {
  if (typeof value !== "string" || value.length > maximum) return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function normalizedOptionalString(
  value: unknown,
  maximum: number,
  allowEmpty = false,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximum) return null;
  const normalized = value.trim();
  return normalized || allowEmpty ? normalized : null;
}

function supplyNumber(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= SUPPLY_NUMBER_LIMIT
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

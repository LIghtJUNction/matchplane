import { z } from "zod";

import {
  parseProductTemplateCatalog,
  parseSupplyFields,
} from "./product-templates";
import type { SupplyFieldConfig } from "./subplatform";

const KEY = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const ATTRIBUTE_KEY = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;
const LABEL = /^.{1,200}$/u;
const FILTER_VALUE = /^.{0,200}$/u;

function stringMap(maxEntries: number) {
  return z
    .record(z.string().regex(KEY), z.string().max(500))
    .refine((value) => Object.keys(value).length <= maxEntries);
}

const filterSchema = z.object({
  key: z.string().regex(KEY),
  label: z.string().regex(LABEL),
  source: z.enum(["trust", "price", "attribute"]),
  attribute: z.string().regex(ATTRIBUTE_KEY).optional(),
  value: z.string().regex(FILTER_VALUE).optional(),
});

const supplyFieldSchema = z.custom<SupplyFieldConfig>(
  (value) => parseSupplyFields([value]) !== null,
);

const manifestUiSchema = z.strictObject({
  chat: stringMap(64).optional(),
  copy: stringMap(128).optional(),
  filters: z.array(filterSchema).max(32).optional(),
  supplyFields: z
    .array(supplyFieldSchema)
    .max(64)
    .refine(
      (fields) =>
        new Set(fields.map((field) => field.key)).size === fields.length,
    )
    .optional(),
});

const manifestProductTemplatesSchema = z.custom<Record<string, unknown>>(
  (value) => parseProductTemplateCatalog(value) !== null,
);

export function validateManifestUi(
  value: Parameters<typeof manifestUiSchema.safeParse>[0],
): boolean {
  return manifestUiSchema.safeParse(value).success;
}

/** Validate the top-level template/default contract, including legacy ambiguity. */
export function validateManifestProductTemplates(value: unknown): boolean {
  return manifestProductTemplatesSchema.safeParse(value).success;
}

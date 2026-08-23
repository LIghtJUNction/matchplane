import { z } from "zod";

const KEY = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const ATTRIBUTE_KEY = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;
const LABEL = /^.{1,200}$/u;
const FILTER_VALUE = /^.{0,200}$/u;
const SUPPLY_PLACEHOLDER = /^.{0,500}$/u;

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

const supplyFieldSchema = z.object({
  key: z.string().regex(ATTRIBUTE_KEY),
  label: z.string().regex(LABEL),
  type: z.enum(["text", "number", "url", "date", "select"]).optional(),
  required: z.boolean().optional(),
  placeholder: z.string().regex(SUPPLY_PLACEHOLDER).optional(),
  options: z.array(z.string().regex(LABEL)).max(64).optional(),
});

const manifestUiSchema = z.strictObject({
  chat: stringMap(64).optional(),
  copy: stringMap(128).optional(),
  filters: z.array(filterSchema).max(32).optional(),
  supplyFields: z.array(supplyFieldSchema).max(64).optional(),
});

export function validateManifestUi(
  value: Parameters<typeof manifestUiSchema.safeParse>[0],
): boolean {
  return manifestUiSchema.safeParse(value).success;
}

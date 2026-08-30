import { z } from "zod";

import { isSafePublicAttributeKey } from "./storefront-ranking-shared";

const KEY = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const ATTRIBUTE_KEY = /^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$/;
const LABEL = /^.{1,200}$/u;
const FILTER_VALUE = /^.{0,200}$/u;
const SUPPLY_NUMBER_LIMIT = 1_000_000_000_000_000;

function nonBlankString(maximum: number) {
  return z
    .string()
    .max(maximum)
    .refine((value) => value.trim().length > 0);
}

const supplyNumber = z
  .number()
  .min(-SUPPLY_NUMBER_LIMIT)
  .max(SUPPLY_NUMBER_LIMIT);

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

const supplyFieldSchema = z
  .strictObject({
    key: z.string().regex(ATTRIBUTE_KEY).refine(isSafePublicAttributeKey),
    label: nonBlankString(200),
    type: z
      .enum(["text", "textarea", "number", "url", "date", "select"])
      .optional(),
    required: z.boolean().optional(),
    placeholder: z.string().max(500).optional(),
    options: z.array(nonBlankString(200)).max(64).optional(),
    group: nonBlankString(120).optional(),
    help: nonBlankString(500).optional(),
    unit: nonBlankString(40).optional(),
    min: supplyNumber.optional(),
    max: supplyNumber.optional(),
    step: supplyNumber.positive().optional(),
  })
  .superRefine((field, context) => {
    const hasNumericConstraint =
      field.min !== undefined ||
      field.max !== undefined ||
      field.step !== undefined;
    if (
      field.min !== undefined &&
      field.max !== undefined &&
      field.min > field.max
    ) {
      context.addIssue({
        code: "custom",
        message: "min must be less than or equal to max",
        path: ["min"],
      });
    }
    if (hasNumericConstraint && field.type !== "number") {
      context.addIssue({
        code: "custom",
        message: "numeric constraints require type number",
        path: ["type"],
      });
    }
    if (field.type === "select" && !field.options?.length) {
      context.addIssue({
        code: "custom",
        message: "select fields require options",
        path: ["options"],
      });
    }
    if (field.options && field.type !== "select") {
      context.addIssue({
        code: "custom",
        message: "options require type select",
        path: ["options"],
      });
    }
    if (
      field.options &&
      new Set(field.options.map((option) => option.trim())).size !==
        field.options.length
    ) {
      context.addIssue({
        code: "custom",
        message: "select options must be unique",
        path: ["options"],
      });
    }
  });

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

export function validateManifestUi(
  value: Parameters<typeof manifestUiSchema.safeParse>[0],
): boolean {
  return manifestUiSchema.safeParse(value).success;
}

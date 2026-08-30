"use client";

import { useId, type ChangeEvent } from "react";

import type { InterfaceLocale } from "../lib/preferences";
import type { SupplyFieldConfig, SupplyFieldType } from "../supply-fields";

export interface SupplyFieldEditorProps {
  fields: readonly SupplyFieldConfig[];
  values: Readonly<Record<string, string>>;
  onValueChange: (key: string, value: string) => void;
  disabled: boolean;
  locale: InterfaceLocale;
}

type IndexedField = { field: SupplyFieldConfig; index: number };
type FieldGroup = { label: string; fields: IndexedField[] };

const SUPPORTED_TYPES: readonly SupplyFieldType[] = [
  "text",
  "textarea",
  "number",
  "url",
  "date",
  "select",
];

export function SupplyFieldEditor({
  fields,
  values,
  onValueChange,
  disabled,
  locale,
}: SupplyFieldEditorProps) {
  const idBase = useId().replace(/:/g, "");
  const visibleFields = fields
    .map((field, index) => ({ field, index }))
    .filter(({ field }) => isSupportedType(field.type));
  if (!visibleFields.length) return null;

  const fallbackGroup = locale === "en" ? "Additional details" : "补充资料";
  const groups = groupFields(visibleFields, fallbackGroup);
  const totalCompleted = countCompleted(visibleFields, values);
  const totalCopy = completionCopy(
    locale,
    totalCompleted,
    visibleFields.length,
  );
  const totalLabel = locale === "en" ? "Overall completion" : "总完成度";

  return (
    <div className="supply-field-editor">
      <div className="supply-field-progress">
        <p className="supply-field-progress-copy">
          <span>{totalLabel}</span>
          <span>{totalCopy}</span>
        </p>
        <progress
          aria-label={totalLabel}
          max={visibleFields.length}
          value={totalCompleted}
        />
      </div>

      <div className="supply-field-groups">
        {groups.map((group, groupIndex) => {
          const completed = countCompleted(group.fields, values);
          const progressLabel =
            locale === "en"
              ? `${group.label} completion`
              : `${group.label}完成度`;
          return (
            <fieldset
              className="supply-field-group"
              key={`${group.label}-${groupIndex}`}
            >
              <legend className="supply-field-group-title">
                {group.label}
              </legend>
              <div className="supply-field-group-header">
                <p className="supply-field-progress-copy">
                  {completionCopy(locale, completed, group.fields.length)}
                </p>
                <progress
                  aria-label={progressLabel}
                  max={group.fields.length}
                  value={completed}
                />
              </div>
              <div className="supply-field-grid">
                {group.fields.map(({ field, index }) => (
                  <SupplyFieldControl
                    key={`${field.key}-${index}`}
                    field={field}
                    value={values[field.key] ?? ""}
                    onValueChange={onValueChange}
                    disabled={disabled}
                    locale={locale}
                    inputId={`${idBase}-supply-field-${index}`}
                  />
                ))}
              </div>
            </fieldset>
          );
        })}
      </div>
    </div>
  );
}

function SupplyFieldControl({
  field,
  value,
  onValueChange,
  disabled,
  locale,
  inputId,
}: {
  field: SupplyFieldConfig;
  value: string;
  onValueChange: SupplyFieldEditorProps["onValueChange"];
  disabled: boolean;
  locale: InterfaceLocale;
  inputId: string;
}) {
  const type = field.type ?? "text";
  const helpId = field.help ? `${inputId}-help` : undefined;
  const unitId = field.unit ? `${inputId}-unit` : undefined;
  const describedBy = [helpId, unitId].filter(Boolean).join(" ") || undefined;
  return (
    <div
      className={`supply-field-control${type === "textarea" ? " is-wide" : ""}`}
    >
      <label htmlFor={inputId}>
        {field.label}
        {field.required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <div className="supply-field-input-shell">
        <SupplyFieldInput
          field={field}
          type={type}
          value={value}
          disabled={disabled}
          inputId={inputId}
          describedBy={describedBy}
          locale={locale}
          onChange={(event) => onValueChange(field.key, event.target.value)}
        />
        {field.unit ? (
          <span className="supply-field-unit" id={unitId}>
            {field.unit}
          </span>
        ) : null}
      </div>
      {field.help ? (
        <small className="supply-field-help" id={helpId}>
          {field.help}
        </small>
      ) : null}
    </div>
  );
}

function SupplyFieldInput({
  field,
  type,
  value,
  disabled,
  inputId,
  describedBy,
  locale,
  onChange,
}: {
  field: SupplyFieldConfig;
  type: SupplyFieldType;
  value: string;
  disabled: boolean;
  inputId: string;
  describedBy: string | undefined;
  locale: InterfaceLocale;
  onChange: (
    event: ChangeEvent<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >,
  ) => void;
}) {
  const commonProps = {
    id: inputId,
    value,
    disabled,
    required: field.required,
    placeholder: field.placeholder,
    "aria-label": field.label,
    "aria-describedby": describedBy,
    onChange,
  };
  switch (type) {
    case "textarea":
      return <textarea {...commonProps} rows={4} />;
    case "select":
      return (
        <select {...commonProps}>
          <option value="">
            {field.placeholder ?? selectPlaceholder(locale)}
          </option>
          {field.options?.map((option, index) => (
            <option key={`${option}-${index}`} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    case "number":
      return (
        <input
          {...commonProps}
          type="number"
          min={field.min}
          max={field.max}
          step={field.step}
        />
      );
    default:
      return <input {...commonProps} type={type} />;
  }
}

function selectPlaceholder(locale: InterfaceLocale): string {
  return locale === "en" ? "Select an option" : "请选择";
}

function groupFields(
  fields: readonly IndexedField[],
  fallbackGroup: string,
): FieldGroup[] {
  const groups = new Map<string, IndexedField[]>();
  for (const indexedField of fields) {
    const label = indexedField.field.group?.trim() || fallbackGroup;
    const group = groups.get(label);
    if (group) group.push(indexedField);
    else groups.set(label, [indexedField]);
  }
  return Array.from(groups, ([label, groupFields]) => ({
    label,
    fields: groupFields,
  }));
}

function countCompleted(
  fields: readonly IndexedField[],
  values: Readonly<Record<string, string>>,
): number {
  return fields.reduce(
    (count, { field }) => (values[field.key]?.trim() ? count + 1 : count),
    0,
  );
}

function completionCopy(
  locale: InterfaceLocale,
  completed: number,
  total: number,
): string {
  return locale === "en"
    ? `${completed} of ${total} completed`
    : `已填写 ${completed} / ${total}`;
}

function isSupportedType(type: SupplyFieldConfig["type"]): boolean {
  return type === undefined || SUPPORTED_TYPES.includes(type);
}

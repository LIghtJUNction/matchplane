"use client";

import { useEffect, useMemo, useState } from "react";

import type { InterfaceLocale } from "../lib/preferences";
import {
  productTemplateSwitchImpact,
  type ProductTemplateConfig,
} from "../product-templates";

interface ProductTemplateSelection {
  templateId: string;
  category: string;
  values: Record<string, string>;
}

interface ProductTemplateSelectorProps {
  templates: ProductTemplateConfig[];
  selectedTemplateId: string | null;
  sourceTemplate?: ProductTemplateConfig | null;
  values: Record<string, string>;
  onConfirm: (selection: ProductTemplateSelection) => void;
  onRefresh: () => void;
  locale: InterfaceLocale;
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
  invalidReason?: string | null;
}

/** Selects an enabled product template without silently discarding field values. */
export function ProductTemplateSelector({
  templates,
  selectedTemplateId,
  sourceTemplate = null,
  values,
  onConfirm,
  onRefresh,
  locale,
  loading = false,
  error = null,
  disabled = false,
  invalidReason = null,
}: ProductTemplateSelectorProps) {
  const english = locale === "en";
  const [pendingTemplateId, setPendingTemplateId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    setPendingTemplateId((current) =>
      current &&
      current !== selectedTemplateId &&
      templates.some((template) => template.id === current)
        ? current
        : null,
    );
  }, [selectedTemplateId, templates]);

  const enabledSelectedTemplate = templates.find(
    (template) => template.id === selectedTemplateId,
  );
  const selectedTemplate =
    sourceTemplate?.id === selectedTemplateId
      ? sourceTemplate
      : enabledSelectedTemplate;
  const selectedTemplateIsEnabled = Boolean(enabledSelectedTemplate);
  const replacementRequired = Boolean(
    invalidReason || !selectedTemplateIsEnabled,
  );
  const pendingTemplate = templates.find(
    (template) => template.id === pendingTemplateId,
  );
  const impact = useMemo(
    () =>
      pendingTemplate
        ? templateSwitchImpact(
            selectedTemplate ?? null,
            pendingTemplate,
            values,
          )
        : null,
    [pendingTemplate, selectedTemplate, values],
  );
  const showTemplateSelect = templates.length > 1 || replacementRequired;

  return (
    <div
      className="product-template-selector seller-upload-wide"
      aria-busy={loading}
    >
      <div className="product-template-selector-heading">
        <div>
          <strong>{english ? "Product template" : "商品模板"}</strong>
          <p>
            {english
              ? "The selected template controls the product-specific fields below."
              : "模板决定下方需要填写的商品专属字段。"}
          </p>
        </div>
        {templates.length === 1 && !replacementRequired ? (
          <span>{english ? "Only enabled template" : "本店唯一启用模板"}</span>
        ) : null}
        <button
          className="text-action"
          type="button"
          disabled={disabled || loading}
          aria-busy={loading}
          onClick={onRefresh}
        >
          {loading
            ? english
              ? "Refreshing templates…"
              : "正在刷新模板…"
            : error
              ? english
                ? "Retry loading templates"
                : "重试加载模板"
              : english
                ? "Refresh template policy"
                : "刷新模板设置"}
        </button>
      </div>

      {loading ? (
        <div className="product-template-selector-state" role="status">
          {english
            ? "Refreshing the policy. The current template and draft stay unchanged."
            : "正在刷新模板设置，当前模板和草稿会保持不变。"}
        </div>
      ) : null}

      {error ? (
        <div className="product-template-selector-state is-error" role="alert">
          <div>
            <strong>
              {english ? "Templates unavailable" : "商品模板加载失败"}
            </strong>
            <p>{error}</p>
          </div>
        </div>
      ) : null}

      {invalidReason ? (
        <div className="product-template-selector-state is-error" role="alert">
          <div>
            <strong>
              {english ? "Template needs replacement" : "当前商品模板需要替换"}
            </strong>
            <p>{invalidReason}</p>
          </div>
        </div>
      ) : null}

      {showTemplateSelect && templates.length ? (
        <label htmlFor="seller-product-template">
          <span>
            {replacementRequired
              ? english
                ? "Choose replacement template"
                : "选择替换模板"
              : english
                ? "Choose template"
                : "选择商品模板"}
          </span>
          <select
            id="seller-product-template"
            aria-label={english ? "Choose product template" : "选择商品模板"}
            value={
              pendingTemplateId ??
              (selectedTemplateIsEnabled ? (selectedTemplateId ?? "") : "")
            }
            disabled={disabled || loading}
            onChange={(event) => {
              const nextId = event.target.value;
              setPendingTemplateId(
                nextId && nextId !== selectedTemplateId ? nextId : null,
              );
            }}
          >
            {!selectedTemplateIsEnabled ? (
              <option value="" disabled>
                {selectedTemplateId
                  ? english
                    ? `Current: ${selectedTemplateId} (unavailable)`
                    : `当前：${selectedTemplateId}（不可用）`
                  : english
                    ? "Current offer has no template"
                    : "当前商品未绑定模板"}
              </option>
            ) : null}
            {templates.map((template) => (
              <option key={template.id} value={template.id}>
                {template.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {selectedTemplate ? (
        <div className="product-template-current">
          <strong>{selectedTemplate.label}</strong>
          {selectedTemplate.category ? (
            <span>{selectedTemplate.category}</span>
          ) : null}
          {selectedTemplate.description ? (
            <p>{selectedTemplate.description}</p>
          ) : null}
        </div>
      ) : selectedTemplateId || invalidReason ? (
        <div className="product-template-current">
          <strong>
            {selectedTemplateId ||
              (english ? "Legacy offer" : "旧版未绑定模板商品")}
          </strong>
          <p>
            {english
              ? "Choose an enabled template explicitly to continue."
              : "请显式选择一个当前启用的模板后再继续。"}
          </p>
        </div>
      ) : null}

      {pendingTemplate && impact ? (
        <div className="product-template-impact" role="status">
          <div>
            <strong>
              {english
                ? `Switch to ${pendingTemplate.label}?`
                : `切换为“${pendingTemplate.label}”？`}
            </strong>
            <p>
              {english
                ? "Nothing changes until you confirm. Review how existing values will be handled."
                : "确认前不会改动任何内容。请先检查现有字段将如何处理。"}
            </p>
          </div>
          <ImpactLine
            label={english ? "Keep" : "保留共享字段"}
            fields={impact.retained}
            empty={english ? "No shared values" : "没有可保留的共享值"}
          />
          <ImpactLine
            label={english ? "Remove" : "清除原模板字段"}
            fields={impact.removed}
            empty={english ? "No source-only values" : "没有需要清除的字段"}
          />
          <ImpactLine
            label={english ? "Required next" : "切换后待填写"}
            fields={impact.required}
            empty={english ? "No new required fields" : "没有新增必填字段"}
          />
          <div className="product-template-impact-actions">
            <button
              className="text-action"
              type="button"
              disabled={disabled || loading}
              onClick={() => setPendingTemplateId(null)}
            >
              {english ? "Cancel" : "取消"}
            </button>
            <button
              className="button button-secondary"
              type="button"
              disabled={disabled || loading}
              onClick={() => {
                onConfirm({
                  templateId: pendingTemplate.id,
                  category: pendingTemplate.category ?? "",
                  values: impact.nextValues,
                });
                setPendingTemplateId(null);
              }}
            >
              {english ? "Confirm switch" : "确认切换"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ImpactLine({
  label,
  fields,
  empty,
}: {
  label: string;
  fields: string[];
  empty: string;
}) {
  return (
    <div className="product-template-impact-line">
      <span>{label}</span>
      <p>{fields.length ? fields.join("、") : empty}</p>
    </div>
  );
}

function templateSwitchImpact(
  source: ProductTemplateConfig | null,
  target: ProductTemplateConfig,
  values: Record<string, string>,
): {
  retained: string[];
  removed: string[];
  required: string[];
  nextValues: Record<string, string>;
} {
  if (!source) {
    return {
      retained: [],
      removed: Object.entries(values)
        .filter(([, value]) => value.trim().length > 0)
        .map(([key]) => key),
      required: target.supplyFields
        .filter((field) => field.required)
        .map((field) => field.label),
      nextValues: {},
    };
  }

  const rawImpact = productTemplateSwitchImpact(
    source.supplyFields,
    target.supplyFields,
  );
  const retainedKeys = new Set(rawImpact.keptKeys);
  const removedKeys = new Set([
    ...rawImpact.removedKeys,
    ...rawImpact.changedKeys,
  ]);
  const nextValues = Object.fromEntries(
    rawImpact.keptKeys
      .filter((key) => Object.hasOwn(values, key))
      .map((key) => [key, values[key] ?? ""]),
  );
  const sourceByKey = new Map(
    source.supplyFields.map((field) => [field.key, field]),
  );

  return {
    retained: rawImpact.keptKeys
      .filter((key) => (values[key] ?? "").trim().length > 0)
      .map((key) => sourceByKey.get(key)?.label ?? key),
    removed: [...removedKeys]
      .filter((key) => (values[key] ?? "").trim().length > 0)
      .map((key) => sourceByKey.get(key)?.label ?? key),
    required: target.supplyFields
      .filter(
        (field) =>
          field.required &&
          (!retainedKeys.has(field.key) ||
            !(values[field.key] ?? "").trim().length),
      )
      .map((field) => field.label),
    nextValues,
  };
}

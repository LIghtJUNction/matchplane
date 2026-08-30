"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  MarketplaceApiError,
  saveStoreProductTemplates,
  type StoreProductTemplateCatalog,
} from "../api";
import type { InterfaceLocale } from "../lib/preferences";

interface StoreProductTemplateSettingsProps {
  storeId: string;
  canManageStore: boolean;
  catalog: StoreProductTemplateCatalog | null;
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onCatalogChange: (catalog: StoreProductTemplateCatalog) => void;
  onNotice: (message: string) => void;
  locale: InterfaceLocale;
}

/** Store-scoped enabled/default product-template policy. */
export function StoreProductTemplateSettings({
  storeId,
  canManageStore,
  catalog,
  loading,
  error,
  onReload,
  onCatalogChange,
  onNotice,
  locale,
}: StoreProductTemplateSettingsProps) {
  const english = locale === "en";
  const [enabledTemplateIds, setEnabledTemplateIds] = useState<string[]>([]);
  const [defaultTemplateId, setDefaultTemplateId] = useState<string | null>(
    null,
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const preserveDraftAfterConflictRef = useRef(false);

  useEffect(() => {
    preserveDraftAfterConflictRef.current = false;
    setEnabledTemplateIds([]);
    setDefaultTemplateId(null);
    setSaveError(null);
    setConflict(false);
  }, [storeId]);

  useEffect(() => {
    if (!catalog) return;
    if (preserveDraftAfterConflictRef.current) {
      preserveDraftAfterConflictRef.current = false;
      setSaveError(null);
      setConflict(false);
      return;
    }
    setEnabledTemplateIds(catalog.enabledTemplateIds);
    setDefaultTemplateId(catalog.defaultTemplateId);
    setSaveError(null);
    setConflict(false);
  }, [catalog]);

  const dirty = useMemo(() => {
    if (!catalog) return false;
    return (
      defaultTemplateId !== catalog.defaultTemplateId ||
      !sameIds(enabledTemplateIds, catalog.enabledTemplateIds)
    );
  }, [catalog, defaultTemplateId, enabledTemplateIds]);

  const save = async () => {
    if (!catalog || saving || !canManageStore) return;
    setSaving(true);
    setSaveError(null);
    setConflict(false);
    try {
      const saved = await saveStoreProductTemplates({
        storeId,
        enabledTemplateIds,
        defaultTemplateId,
        expectedStoreVersion: catalog.storeVersion,
        expectedCatalogRevision: catalog.catalogRevision,
      });
      onCatalogChange(saved);
      onNotice(
        english ? "Product-template policy saved" : "商品模板设置已保存",
      );
    } catch (caught) {
      const message =
        caught instanceof Error
          ? caught.message
          : english
            ? "Could not save product-template policy"
            : "商品模板设置保存失败";
      setSaveError(message);
      setConflict(
        caught instanceof MarketplaceApiError && caught.status === 409,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className="store-product-template-settings"
      aria-labelledby="store-product-template-settings-title"
    >
      <div className="store-product-template-settings-heading">
        <div>
          <p>{english ? "PRODUCT POLICY" : "商品策略"}</p>
          <h2 id="store-product-template-settings-title">
            {english ? "Product templates" : "商品模板"}
          </h2>
          <span>
            {english
              ? "Choose which manifest templates staff can use for new products."
              : "选择本店发布新商品时可以使用的模板，并指定默认模板。"}
          </span>
        </div>
        {!loading && catalog ? (
          <span className="store-product-template-settings-access">
            {canManageStore
              ? english
                ? "Manager editable"
                : "店主可编辑"
              : english
                ? "Read only"
                : "店员只读"}
          </span>
        ) : null}
      </div>

      {loading ? (
        <div className="store-product-template-settings-state" role="status">
          {english ? "Loading template policy…" : "正在加载模板设置…"}
        </div>
      ) : error ? (
        <div
          className="store-product-template-settings-state is-error"
          role="alert"
        >
          <div>
            <strong>
              {english ? "Template policy unavailable" : "模板设置加载失败"}
            </strong>
            <p>{error}</p>
          </div>
          <button className="text-action" type="button" onClick={onReload}>
            {english ? "Reload" : "重新加载"}
          </button>
        </div>
      ) : catalog ? (
        catalog.templates.length ? (
          <>
            <ul className="store-product-template-list">
              {catalog.templates.map((template) => {
                const checked = enabledTemplateIds.includes(template.id);
                return (
                  <li key={template.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!canManageStore || saving}
                        onChange={(event) => {
                          const nextEnabled = event.target.checked
                            ? [...enabledTemplateIds, template.id]
                            : enabledTemplateIds.filter(
                                (templateId) => templateId !== template.id,
                              );
                          setEnabledTemplateIds(nextEnabled);
                          if (!nextEnabled.includes(defaultTemplateId ?? ""))
                            setDefaultTemplateId(nextEnabled[0] ?? null);
                          setConflict(false);
                          setSaveError(null);
                        }}
                      />
                      <span className="store-product-template-check" />
                      <span className="store-product-template-copy">
                        <strong>{template.label}</strong>
                        <small>{template.category}</small>
                        <span>{template.description}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>

            <div className="store-product-template-settings-controls">
              <label htmlFor={`store-product-template-default-${storeId}`}>
                <span>{english ? "Default template" : "默认商品模板"}</span>
                <select
                  id={`store-product-template-default-${storeId}`}
                  value={defaultTemplateId ?? ""}
                  disabled={
                    !canManageStore || saving || enabledTemplateIds.length === 0
                  }
                  onChange={(event) =>
                    setDefaultTemplateId(event.target.value || null)
                  }
                >
                  {enabledTemplateIds.length === 0 ? (
                    <option value="">
                      {english ? "No enabled templates" : "没有启用模板"}
                    </option>
                  ) : null}
                  {catalog.templates
                    .filter((template) =>
                      enabledTemplateIds.includes(template.id),
                    )
                    .map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.label}
                      </option>
                    ))}
                </select>
              </label>
              <p className={enabledTemplateIds.length ? "" : "is-warning"}>
                {enabledTemplateIds.length
                  ? english
                    ? "New products start with the default; staff may choose another enabled template."
                    : "新商品会预选默认模板，店员也可改选其他已启用模板。"
                  : english
                    ? "New product publishing is paused until at least one template is enabled."
                    : "未启用任何模板：本店将暂停发布新商品。"}
              </p>
            </div>

            {saveError ? (
              <div
                className="store-product-template-settings-state is-error"
                role="alert"
              >
                <div>
                  <strong>
                    {conflict
                      ? english
                        ? "Policy changed elsewhere"
                        : "模板设置已在其他页面更新"
                      : english
                        ? "Save failed"
                        : "保存失败"}
                  </strong>
                  <p>{saveError}</p>
                </div>
                {conflict ? (
                  <button
                    className="text-action"
                    type="button"
                  onClick={() => {
                    preserveDraftAfterConflictRef.current = true;
                    onReload();
                  }}
                >
                  {english ? "Refresh template policy" : "刷新模板设置"}
                  </button>
                ) : null}
              </div>
            ) : null}

            {canManageStore ? (
              <div className="store-product-template-settings-actions">
                <span aria-live="polite">
                  {dirty
                    ? english
                      ? "Unsaved changes"
                      : "有未保存的修改"
                    : english
                      ? "Policy is up to date"
                      : "设置已是最新"}
                </span>
                <button
                  className="button button-dark"
                  type="button"
                  disabled={!dirty || saving || conflict}
                  aria-busy={saving}
                  onClick={() => void save()}
                >
                  {saving
                    ? english
                      ? "Saving…"
                      : "正在保存…"
                    : english
                      ? "Save policy"
                      : "保存模板设置"}
                </button>
              </div>
            ) : (
              <p className="store-product-template-readonly">
                {english
                  ? "Store staff can use enabled templates but only a store manager can change this policy."
                  : "店员可以使用已启用模板，但只有店主或管理员能修改这项设置。"}
              </p>
            )}
          </>
        ) : (
          <div className="store-product-template-settings-state">
            <strong>
              {english ? "No template catalog" : "当前子平台未提供商品模板"}
            </strong>
            <p>
              {english
                ? "This store continues to use its legacy or generic product fields."
                : "本店继续沿用现有通用字段或旧版供给字段。"}
            </p>
          </div>
        )
      ) : null}
    </section>
  );
}

function sameIds(first: string[], second: string[]): boolean {
  if (first.length !== second.length) return false;
  const left = [...first].sort((a, b) => a.localeCompare(b));
  const right = [...second].sort((a, b) => a.localeCompare(b));
  return left.every((value, index) => value === right[index]);
}

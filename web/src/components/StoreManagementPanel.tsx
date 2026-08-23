"use client";

import { type SyntheticEvent, useEffect, useState } from "react";
import { Save, Store } from "lucide-react";

import {
  getStoreManagement,
  updateStoreManagement,
  type StoreSummary,
} from "../api";

export function StoreManagementPanel({
  store,
  canManageStore,
  onNotice,
  onUpdated,
}: {
  store: StoreSummary;
  canManageStore: boolean;
  onNotice: (message: string) => void;
  onUpdated: (store: StoreSummary) => void;
}) {
  const [current, setCurrent] = useState(store);
  const [displayName, setDisplayName] = useState(store.displayName);
  const [description, setDescription] = useState(store.description);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void getStoreManagement(store.id)
      .then((next) => {
        if (!active) return;
        setCurrent(next.store);
        setDisplayName(next.store.displayName);
        setDescription(next.store.description);
      })
      .catch((error) => {
        if (active)
          onNotice(error instanceof Error ? error.message : "店铺资料读取失败");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [onNotice, store.id]);

  const save = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canManageStore || saving || !current.version) return;
    setSaving(true);
    try {
      const updated = await updateStoreManagement({
        storeId: current.id,
        displayName,
        description,
        expectedVersion: current.version,
      });
      setCurrent(updated);
      onUpdated(updated);
      onNotice("店铺资料已保存");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "店铺资料保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className="surface store-management-panel"
      aria-labelledby="store-management-title"
    >
      <div className="store-management-heading">
        <span aria-hidden="true">
          <Store size={19} />
        </span>
        <div>
          <h2 id="store-management-title">店铺资料</h2>
          <p>商城审核店铺状态；店长维护店名和对外简介。</p>
        </div>
      </div>
      <form className="store-management-form" onSubmit={save}>
        <label htmlFor="store-management-name">
          <span>店铺名称</span>
          <input
            id="store-management-name"
            value={displayName}
            disabled={!canManageStore || loading}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={200}
          />
        </label>
        <label htmlFor="store-management-description">
          <span>店铺简介</span>
          <textarea
            id="store-management-description"
            value={description}
            disabled={!canManageStore || loading}
            onChange={(event) => setDescription(event.target.value)}
            rows={4}
            maxLength={2000}
            placeholder="说明主营车源和服务范围"
          />
        </label>
        <div className="store-management-meta">
          <span>地址 {current.path}</span>
          <span>
            {current.status === "active"
              ? "营业中"
              : current.status === "pending"
                ? "审核中"
                : "暂不可公开"}
          </span>
        </div>
        {canManageStore ? (
          <button
            className="button button-dark"
            type="submit"
            disabled={saving || loading}
          >
            <Save size={16} aria-hidden="true" />
            {saving ? "保存中…" : "保存店铺资料"}
          </button>
        ) : (
          <p className="store-management-readonly">
            店员可以管理商品；店铺资料由店长或商城后台维护。
          </p>
        )}
      </form>
    </section>
  );
}

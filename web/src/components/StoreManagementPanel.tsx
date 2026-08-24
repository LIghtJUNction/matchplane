"use client";

import { type SyntheticEvent, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Moon,
  Play,
  PowerOff,
  Save,
  Store,
} from "lucide-react";

import {
  getStoreManagement,
  updateStoreLifecycle,
  updateStoreManagement,
  type StoreSummary,
} from "../api";
import type { InterfaceLocale } from "../lib/preferences";

export function StoreManagementPanel({
  store,
  canManageStore,
  onNotice,
  onUpdated,
  locale = "zh",
}: {
  store: StoreSummary;
  canManageStore: boolean;
  onNotice: (message: string) => void;
  onUpdated: (store: StoreSummary) => void;
  locale?: InterfaceLocale;
}) {
  const isEn = locale === "en";
  const [current, setCurrent] = useState(store);
  const [displayName, setDisplayName] = useState(store.displayName);
  const [description, setDescription] = useState(store.description);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lifecycleLoading, setLifecycleLoading] = useState(false);
  const [confirmingClose, setConfirmingClose] = useState(false);

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
          onNotice(
            error instanceof Error
              ? error.message
              : isEn
                ? "Failed to load store details"
                : "店铺资料读取失败",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [isEn, onNotice, store.id]);

  const refreshStore = async () => {
    try {
      const next = await getStoreManagement(current.id);
      setCurrent(next.store);
      setDisplayName(next.store.displayName);
      setDescription(next.store.description);
      onUpdated(next.store);
    } catch {
      // quiet refresh error
    }
  };

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
      onNotice(isEn ? "Store details saved" : "店铺资料已保存");
    } catch (error) {
      onNotice(
        error instanceof Error
          ? error.message
          : isEn
            ? "Failed to save store details"
            : "店铺资料保存失败",
      );
      void refreshStore();
    } finally {
      setSaving(false);
    }
  };

  const handleLifecycleChange = async (action: "close" | "reopen") => {
    if (!canManageStore || lifecycleLoading || !current.version) return;
    setLifecycleLoading(true);
    try {
      const updated = await updateStoreLifecycle({
        storeId: current.id,
        action,
        expectedVersion: current.version,
      });
      setCurrent(updated);
      onUpdated(updated);
      setConfirmingClose(false);
      onNotice(
        action === "close"
          ? isEn
            ? "Store paused and hidden from public catalog"
            : "店铺已暂停营业，已从搜索和公开目录中隐藏"
          : isEn
            ? "Store reopened and is now live"
            : "店铺已恢复营业，商品已重新对外开放",
      );
    } catch (error) {
      onNotice(
        error instanceof Error
          ? error.message
          : isEn
            ? "Failed to update business status"
            : "店铺营业状态更新失败",
      );
      void refreshStore();
    } finally {
      setLifecycleLoading(false);
    }
  };

  const status = current.status ?? "active";

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
          <h2 id="store-management-title">
            {isEn ? "Store Details & Status" : "店铺资料与营业状态"}
          </h2>
          <p>
            {isEn
              ? "Manage store profile, public description, and open/close operating status."
              : "管理店铺基本信息与营业状态。店长可自主开启或暂停对外营业。"}
          </p>
        </div>
      </div>

      {/* Business Status & Lifecycle Section */}
      <div className="store-lifecycle-card">
        <div className="store-lifecycle-header">
          <div className="store-lifecycle-info">
            <span className="store-lifecycle-label">
              {isEn ? "Operating Status" : "营业状态"}
            </span>
            <div className="store-lifecycle-status-row">
              {status === "active" && (
                <span className="store-status-badge is-active">
                  <CheckCircle2 size={13} aria-hidden="true" />
                  {isEn ? "Open for business" : "正常营业中"}
                </span>
              )}
              {status === "closed" && (
                <span className="store-status-badge is-closed">
                  <Moon size={13} aria-hidden="true" />
                  {isEn ? "Closed / Paused" : "已打烊 · 暂停营业"}
                </span>
              )}
              {status === "pending" && (
                <span className="store-status-badge is-pending">
                  <Clock size={13} aria-hidden="true" />
                  {isEn ? "Under review" : "审核中"}
                </span>
              )}
              {status === "suspended" && (
                <span className="store-status-badge is-suspended">
                  <AlertTriangle size={13} aria-hidden="true" />
                  {isEn ? "Suspended by platform" : "已被平台暂停"}
                </span>
              )}
            </div>
            <p className="store-lifecycle-desc">
              {status === "active" &&
                (isEn
                  ? "Your store and products are visible in search and recommendations. Customers can browse, consult, and place orders."
                  : "店铺正常对外展示。商品可被商城搜索和智能助手撮合推荐，顾客可正常发起咨询与下单。")}
              {status === "closed" &&
                (isEn
                  ? "Your store is currently paused. Products are hidden from public search, but all data is safely kept. You can reopen at any time."
                  : "店铺当前处于暂停营业状态。商品已从公共搜索和推荐中隐藏，现有数据完整保留。您可以随时点击「恢复营业」重新开放。")}
              {status === "pending" &&
                (isEn
                  ? "Store onboarding is being reviewed. It will become active once approved."
                  : "店铺接入与资料正在审核中，审核通过后将自动开放营业。")}
              {status === "suspended" &&
                (isEn
                  ? "Store operations have been suspended by mall management. Please contact platform staff."
                  : "店铺已被商城管理暂停，店主无法自行恢复。如有疑问请联系商城客服或运营人员。")}
            </p>
          </div>

          {canManageStore && (status === "active" || status === "closed") && (
            <div className="store-lifecycle-action-wrapper">
              {status === "active" && !confirmingClose && (
                <button
                  type="button"
                  className="button button-danger-subtle"
                  onClick={() => setConfirmingClose(true)}
                  disabled={lifecycleLoading || loading}
                >
                  <PowerOff size={15} aria-hidden="true" />
                  {isEn ? "Pause operations (Close)" : "暂停营业（关闭店铺）"}
                </button>
              )}
              {status === "closed" && (
                <button
                  type="button"
                  className="button button-dark"
                  onClick={() => void handleLifecycleChange("reopen")}
                  disabled={lifecycleLoading || loading}
                >
                  <Play size={15} aria-hidden="true" />
                  {lifecycleLoading
                    ? isEn
                      ? "Reopening…"
                      : "正在恢复…"
                    : isEn
                      ? "Reopen store"
                      : "恢复营业（重新开店）"}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Inline confirmation for closing store */}
        {confirmingClose && status === "active" && (
          <div className="store-lifecycle-confirm" role="alert">
            <div className="store-lifecycle-confirm-content">
              <strong>
                {isEn ? "Pause store operations?" : "确定要暂停营业（关闭店铺）吗？"}
              </strong>
              <p>
                {isEn
                  ? "Once closed, the store and its products will be hidden from public search and cannot receive new orders. All catalog items, customer records, and settings remain safe and can be restored anytime."
                  : "暂停营业后，店铺及其旗下所有商品将从商城公开搜索与推荐列表中暂时隐藏，顾客将无法发起新的咨询或下单。所有商品数据、客户记录与经营历史均完整保留，您可以随时点击「恢复营业」重新开放。"}
              </p>
            </div>
            <div className="store-lifecycle-confirm-actions">
              <button
                type="button"
                className="button button-danger"
                onClick={() => void handleLifecycleChange("close")}
                disabled={lifecycleLoading}
              >
                <PowerOff size={15} aria-hidden="true" />
                {lifecycleLoading
                  ? isEn
                    ? "Pausing…"
                    : "正在暂停…"
                  : isEn
                    ? "Confirm pause operations"
                    : "确认暂停营业"}
              </button>
              <button
                type="button"
                className="button button-ghost"
                onClick={() => setConfirmingClose(false)}
                disabled={lifecycleLoading}
              >
                {isEn ? "Cancel" : "取消"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Store Basic Profile Form */}
      <form className="store-management-form" onSubmit={save}>
        <label htmlFor="store-management-name">
          <span>{isEn ? "Store name" : "店铺名称"}</span>
          <input
            id="store-management-name"
            value={displayName}
            disabled={!canManageStore || loading || saving}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={200}
            placeholder={isEn ? "Enter store name" : "输入店铺名称"}
          />
        </label>
        <label htmlFor="store-management-description">
          <span>{isEn ? "Store description" : "店铺简介"}</span>
          <textarea
            id="store-management-description"
            value={description}
            disabled={!canManageStore || loading || saving}
            onChange={(event) => setDescription(event.target.value)}
            rows={4}
            maxLength={2000}
            placeholder={
              isEn
                ? "Describe main products, specialties, and service scope"
                : "说明主营商品特色与服务范围"
            }
          />
        </label>
        <div className="store-management-meta">
          <span>
            {isEn ? "Store URL:" : "店铺地址："} {current.path}
          </span>
          <span>
            {isEn ? "Version:" : "资料版本："} v{current.version ?? 1}
          </span>
        </div>
        {canManageStore ? (
          <button
            className="button button-dark"
            type="submit"
            disabled={saving || loading || lifecycleLoading}
          >
            <Save size={16} aria-hidden="true" />
            {saving
              ? isEn
                ? "Saving…"
                : "保存中…"
              : isEn
                ? "Save store details"
                : "保存店铺资料"}
          </button>
        ) : (
          <p className="store-management-readonly">
            {isEn
              ? "Staff can manage products; store profile and operating status are managed by the store owner."
              : "店员可以管理商品；店铺资料与营业状态由店长或商城后台维护。"}
          </p>
        )}
      </form>
    </section>
  );
}

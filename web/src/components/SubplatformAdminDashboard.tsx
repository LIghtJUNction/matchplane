"use client";

import { useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@appica/ui-react/tabs";
import {
  Moon,
  Package,
  ReceiptText,
  ShieldCheck,
  Store,
  UserSearch,
  UsersRound,
} from "lucide-react";

import type { StoreSummary, SubplatformOrganizationRecord } from "../api";
import type { InterfaceLocale } from "../lib/preferences";
import type { SubplatformConfig } from "../subplatform";
import { HorizontalTabScroller } from "./HorizontalTabScroller";
import { PlatformAccessPanel } from "./PlatformAccessPanel";
import { SellerDashboard } from "./SellerDashboard";
import { StoreCustomersPanel } from "./StoreCustomersPanel";
import { StoreFinancePanel } from "./StoreFinancePanel";
import { StoreManagementPanel } from "./StoreManagementPanel";

type StoreConsoleSection =
  | "products"
  | "customers"
  | "finance"
  | "store"
  | "team";

/** Store operators manage commerce only; mall infrastructure stays in the root console. */
export function SubplatformAdminDashboard({
  locale,
  onNotice,
  subplatform,
  store,
  canManageStore,
  onStoreUpdated,
  initialSection = "products",
}: {
  locale: InterfaceLocale;
  onNotice: (message: string) => void;
  subplatform: SubplatformConfig;
  store: StoreSummary;
  canManageStore: boolean;
  onStoreUpdated: (store: StoreSummary) => void;
  initialSection?: "products" | "customers";
}) {
  const [section, setSection] = useState<StoreConsoleSection>(initialSection);
  const [visitedSections, setVisitedSections] = useState<
    ReadonlySet<StoreConsoleSection>
  >(() => new Set([initialSection]));
  const english = locale === "en";

  const activateSection = (nextSection: StoreConsoleSection) => {
    const requiresManagement =
      nextSection === "finance" ||
      nextSection === "store" ||
      nextSection === "team";
    if (requiresManagement && !canManageStore) return;

    setVisitedSections((visited) =>
      visited.has(nextSection) ? visited : new Set(visited).add(nextSection),
    );
    setSection(nextSection);
  };

  return (
    <div className="dashboard subplatform-admin-dashboard">
      {store.status === "closed" && (
        <div className="store-closed-banner" role="status">
          <div className="store-closed-banner-content">
            <Moon size={16} aria-hidden="true" />
            <span>
              {english
                ? "This store is currently closed/paused and hidden from public search."
                : "当前店铺处于「已打烊 · 暂停营业」状态，已从商城公开搜索与推荐中隐藏。"}
            </span>
          </div>
          {canManageStore && section !== "store" && (
            <button
              type="button"
              className="store-closed-banner-action"
              onClick={() => activateSection("store")}
            >
              {english
                ? "Go to store details to reopen"
                : "前往店铺资料恢复营业"}
            </button>
          )}
        </div>
      )}

      <div className="store-console-toolbar">
        <HorizontalTabScroller
          activeKey={section}
          className="w-full min-w-0 flex-1"
          locale={locale}
        >
          <Tabs
            value={section}
            onValueChange={(value) =>
              activateSection(value as StoreConsoleSection)
            }
            variant="pill"
            size="md"
            className="store-management-tabs min-w-max"
          >
            <TabsList
              aria-label={
                english ? "Store management sections" : "店铺管理分区"
              }
              className="w-max min-w-max"
            >
              <TabsTrigger value="products" className="min-h-11">
                <Package size={16} aria-hidden="true" />
                {english ? "Products" : "商品"}
              </TabsTrigger>
              <TabsTrigger value="customers" className="min-h-11">
                <UserSearch size={16} aria-hidden="true" />
                {english ? "Customer management" : "客户管理"}
              </TabsTrigger>
              {canManageStore ? (
                <TabsTrigger value="finance" className="min-h-11">
                  <ReceiptText size={16} aria-hidden="true" />
                  {english ? "Finance" : "财务"}
                </TabsTrigger>
              ) : null}
              {canManageStore ? (
                <TabsTrigger value="store" className="min-h-11">
                  <Store size={16} aria-hidden="true" />
                  {english ? "Store details" : "店铺资料"}
                </TabsTrigger>
              ) : null}
              {canManageStore ? (
                <TabsTrigger value="team" className="min-h-11">
                  <UsersRound size={16} aria-hidden="true" />
                  {english ? "Team" : "店员"}
                </TabsTrigger>
              ) : null}
            </TabsList>
          </Tabs>
        </HorizontalTabScroller>
        <span className="store-console-scope">
          <ShieldCheck size={16} aria-hidden="true" />
          {canManageStore
            ? english
              ? "Store manager"
              : "仅限本店"
            : english
              ? "Store staff"
              : "店员权限"}
        </span>
      </div>

      <div className="store-console-content">
        {visitedSections.has("products") ? (
          <div hidden={section !== "products"}>
            <SellerDashboard
              locale={locale}
              onNotice={onNotice}
              subplatform={subplatform}
            />
          </div>
        ) : null}
        {visitedSections.has("customers") ? (
          <div hidden={section !== "customers"}>
            <StoreCustomersPanel storeId={store.id} locale={locale} />
          </div>
        ) : null}
        {canManageStore && visitedSections.has("finance") ? (
          <div hidden={section !== "finance"}>
            <StoreFinancePanel
              locale={locale}
              onNotice={onNotice}
              store={store}
            />
          </div>
        ) : null}
        {canManageStore && visitedSections.has("store") ? (
          <div hidden={section !== "store"}>
            <StoreManagementPanel
              store={store}
              canManageStore={canManageStore}
              onNotice={onNotice}
              onUpdated={onStoreUpdated}
              locale={locale}
            />
          </div>
        ) : null}
        {canManageStore && visitedSections.has("team") ? (
          <div hidden={section !== "team"}>
            <PlatformAccessPanel
              organizations={
                subplatform.organizationId
                  ? [scopedOrganization(subplatform)]
                  : []
              }
              rootRole="subplatform_admin"
              onNotice={onNotice}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function scopedOrganization(
  subplatform: SubplatformConfig,
): SubplatformOrganizationRecord {
  return {
    id: subplatform.organizationId!,
    name: subplatform.brandName,
    slug: subplatform.slug,
    parentOrganizationId: null,
    tenantId: subplatform.tenantId ?? "",
    domainId: subplatform.domainId ?? "",
    sourceRepository: null,
    createdAt: "",
    registrationId: null,
    registrationState: "active",
    buildDigest: null,
    manifestDigest: null,
  };
}

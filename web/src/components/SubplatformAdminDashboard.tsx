"use client";

import { useState } from "react";
import {
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
import { PlatformAccessPanel } from "./PlatformAccessPanel";
import { SellerDashboard } from "./SellerDashboard";
import { StoreCustomersPanel } from "./StoreCustomersPanel";
import { StoreFinancePanel } from "./StoreFinancePanel";
import { StoreManagementPanel } from "./StoreManagementPanel";

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
  const [section, setSection] = useState<
    "products" | "customers" | "finance" | "store" | "team"
  >(initialSection);
  const english = locale === "en";

  return (
    <div className="dashboard subplatform-admin-dashboard">
      <div className="store-console-toolbar">
        <nav
          className="store-management-tabs"
          role="tablist"
          aria-label={english ? "Store management sections" : "店铺管理分区"}
        >
          <button
            type="button"
            role="tab"
            aria-selected={section === "products"}
            className={section === "products" ? "is-active" : ""}
            onClick={() => setSection("products")}
          >
            <Package size={16} aria-hidden="true" />
            {english ? "Products" : "商品"}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={section === "customers"}
            className={section === "customers" ? "is-active" : ""}
            onClick={() => setSection("customers")}
          >
            <UserSearch size={16} aria-hidden="true" />
            {english ? "Customers" : "客户"}
          </button>
          {canManageStore ? (
            <button
              type="button"
              role="tab"
              aria-selected={section === "finance"}
              className={section === "finance" ? "is-active" : ""}
              onClick={() => setSection("finance")}
            >
              <ReceiptText size={16} aria-hidden="true" />
              {english ? "Finance" : "财务"}
            </button>
          ) : null}
          {canManageStore ? (
            <button
              type="button"
              role="tab"
              aria-selected={section === "store"}
              className={section === "store" ? "is-active" : ""}
              onClick={() => setSection("store")}
            >
              <Store size={16} aria-hidden="true" />
              {english ? "Store details" : "店铺资料"}
            </button>
          ) : null}
          {canManageStore ? (
            <button
              type="button"
              role="tab"
              aria-selected={section === "team"}
              className={section === "team" ? "is-active" : ""}
              onClick={() => setSection("team")}
            >
              <UsersRound size={16} aria-hidden="true" />
              {english ? "Team" : "店员"}
            </button>
          ) : null}
        </nav>
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
        <div hidden={section !== "products"}>
          <SellerDashboard
            locale={locale}
            onNotice={onNotice}
            subplatform={subplatform}
          />
        </div>
        <div hidden={section !== "customers"}>
          <StoreCustomersPanel storeId={store.id} locale={locale} />
        </div>
        {canManageStore && section === "finance" ? (
          <StoreFinancePanel
            locale={locale}
            onNotice={onNotice}
            store={store}
          />
        ) : null}
        {canManageStore ? (
          <div hidden={section !== "store"}>
            <StoreManagementPanel
              store={store}
              canManageStore={canManageStore}
              onNotice={onNotice}
              onUpdated={onStoreUpdated}
            />
          </div>
        ) : null}
        {canManageStore ? (
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

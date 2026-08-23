import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./SellerDashboard", () => ({
  SellerDashboard: () => <div>products-panel</div>,
}));
vi.mock("./StoreFinancePanel", () => ({
  StoreFinancePanel: () => <div>finance-panel</div>,
}));
vi.mock("./StoreManagementPanel", () => ({
  StoreManagementPanel: () => <div>store-panel</div>,
}));
vi.mock("./PlatformAccessPanel", () => ({
  PlatformAccessPanel: () => <div>team-panel</div>,
}));

import { resolveSubplatform } from "../subplatform";
import { SubplatformAdminDashboard } from "./SubplatformAdminDashboard";

const store = {
  id: "11111111-1111-4111-8111-111111111111",
  tenantId: "22222222-2222-4222-8222-222222222222",
  domainId: "33333333-3333-4333-8333-333333333333",
  slug: "human-store",
  name: "正常人类店铺",
  displayName: "正常人类店铺",
  description: "只卖清楚标价的商品",
  path: "/stores/human-store",
  integrationKind: "hosted" as const,
  visibility: "public" as const,
  state: "active" as const,
  role: "owner" as const,
  canManage: true,
};

describe("SubplatformAdminDashboard", () => {
  it("keeps mall email infrastructure out of a store owner's workspace", () => {
    render(
      <SubplatformAdminDashboard
        locale="zh"
        onNotice={vi.fn()}
        subplatform={{
          ...resolveSubplatform("/stores/human-store"),
          organizationId: "44444444-4444-4444-8444-444444444444",
          tenantId: store.tenantId,
          domainId: store.domainId,
        }}
        store={store}
        canManageStore
        onStoreUpdated={vi.fn()}
      />,
    );

    expect(screen.getByRole("tab", { name: "商品" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "财务" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "店铺资料" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "店员" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "经营管理" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "通知" })).not.toBeInTheDocument();
    expect(
      screen.queryByText(/SMTP|Secret reference|通知邮件/),
    ).not.toBeInTheDocument();
  });
});

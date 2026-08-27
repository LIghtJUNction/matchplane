import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./SellerDashboard", () => ({
  SellerDashboard: () => <div>products-panel</div>,
}));
vi.mock("./StoreCustomersPanel", async () => {
  const { useEffect } = await import("react");

  return {
    StoreCustomersPanel: () => {
      useEffect(() => {
        void fetch("/test/customers");
      }, []);

      return <div>customers-panel</div>;
    },
  };
});
vi.mock("./StoreFinancePanel", async () => {
  const { useEffect } = await import("react");

  return {
    StoreFinancePanel: () => {
      useEffect(() => {
        void fetch("/test/finance");
      }, []);

      return <div>finance-panel</div>;
    },
  };
});
vi.mock("./StoreManagementPanel", async () => {
  const { useEffect } = await import("react");

  return {
    StoreManagementPanel: () => {
      useEffect(() => {
        void fetch("/test/management");
      }, []);

      return (
        <label>
          store-state
          <input aria-label="store-state" />
        </label>
      );
    },
  };
});
vi.mock("./PlatformAccessPanel", async () => {
  const { useEffect } = await import("react");

  return {
    PlatformAccessPanel: () => {
      useEffect(() => {
        void fetch("/test/access");
      }, []);

      return <div>team-panel</div>;
    },
  };
});

import { resolveSubplatform } from "../subplatform";
import { SubplatformAdminDashboard } from "./SubplatformAdminDashboard";

const fetchMock = vi.fn((_input: RequestInfo | URL) =>
  Promise.resolve(new Response(null, { status: 204 })),
);

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

const subplatform = {
  ...resolveSubplatform("/stores/human-store"),
  organizationId: "44444444-4444-4444-8444-444444444444",
  tenantId: store.tenantId,
  domainId: store.domainId,
};

function renderDashboard(canManageStore = true) {
  return render(
    <SubplatformAdminDashboard
      locale="zh"
      onNotice={vi.fn()}
      subplatform={subplatform}
      store={store}
      canManageStore={canManageStore}
      onStoreUpdated={vi.fn()}
    />,
  );
}

function requestCount(path: string) {
  return fetchMock.mock.calls.filter(([input]) => input === path).length;
}

describe("SubplatformAdminDashboard", () => {
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  it.each([320, 390])(
    "contains the store tabs without document overflow at %ipx",
    (width) => {
      const { container } = render(
        <div style={{ width }}>
          <SubplatformAdminDashboard
            locale="zh"
            onNotice={vi.fn()}
            subplatform={subplatform}
            store={store}
            canManageStore
            onStoreUpdated={vi.fn()}
          />
        </div>,
      );

      const scroller = container.querySelector(
        '[data-horizontal-tab-scroller="true"]',
      );
      const viewport = container.querySelector(
        '[data-horizontal-tab-scroller-viewport="true"]',
      );
      expect(scroller).toHaveClass("min-w-0", "w-full");
      expect(viewport).toHaveClass("min-w-0", "overflow-x-auto");
      expect(viewport).toContainElement(
        screen.getByRole("tablist", { name: "店铺管理分区" }),
      );
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    },
  );

  it("keeps mall email infrastructure out of a store owner's workspace", () => {
    renderDashboard();

    expect(screen.getByRole("tab", { name: "商品" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "财务" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "店铺资料" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "店员" })).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "经营管理" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "通知" })).not.toBeInTheDocument();
    expect(
      screen.queryByText(/SMTP|Secret reference|通知邮件/),
    ).not.toBeInTheDocument();
  });

  it("mounts only products on first render", () => {
    renderDashboard();

    expect(screen.getByText("products-panel")).toBeVisible();
    expect(screen.queryByText("customers-panel")).not.toBeInTheDocument();
    expect(screen.queryByText("finance-panel")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("store-state")).not.toBeInTheDocument();
    expect(screen.queryByText("team-panel")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("initializes each section once and preserves panel state across visits", async () => {
    const user = userEvent.setup();
    renderDashboard();

    await user.click(screen.getByRole("tab", { name: "客户管理" }));
    expect(requestCount("/test/customers")).toBe(1);

    await user.click(screen.getByRole("tab", { name: "店铺资料" }));
    expect(requestCount("/test/management")).toBe(1);
    await user.type(screen.getByLabelText("store-state"), "draft survives");

    await user.click(screen.getByRole("tab", { name: "店员" }));
    expect(requestCount("/test/access")).toBe(1);

    await user.click(screen.getByRole("tab", { name: "财务" }));
    expect(requestCount("/test/finance")).toBe(1);

    await user.click(screen.getByRole("tab", { name: "客户管理" }));
    await user.click(screen.getByRole("tab", { name: "店铺资料" }));
    expect(screen.getByLabelText("store-state")).toHaveValue("draft survives");
    await user.click(screen.getByRole("tab", { name: "店员" }));
    await user.click(screen.getByRole("tab", { name: "财务" }));

    expect(requestCount("/test/customers")).toBe(1);
    expect(requestCount("/test/management")).toBe(1);
    expect(requestCount("/test/access")).toBe(1);
    expect(requestCount("/test/finance")).toBe(1);
  });

  it("does not mount management-only panels without management permission", () => {
    renderDashboard(false);

    expect(screen.queryByRole("tab", { name: "财务" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: "店铺资料" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "店员" })).not.toBeInTheDocument();
    expect(requestCount("/test/finance")).toBe(0);
    expect(requestCount("/test/management")).toBe(0);
    expect(requestCount("/test/access")).toBe(0);
  });
});

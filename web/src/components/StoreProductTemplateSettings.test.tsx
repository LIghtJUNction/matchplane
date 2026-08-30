import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MarketplaceApiError,
  type StoreProductTemplateCatalog,
} from "../api";
import { StoreProductTemplateSettings } from "./StoreProductTemplateSettings";

const api = vi.hoisted(() => ({
  saveStoreProductTemplates: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, saveStoreProductTemplates: api.saveStoreProductTemplates };
});

const catalog: StoreProductTemplateCatalog = {
  storeId: "store-1",
  storeVersion: 7,
  catalogRevision: "revision-1",
  templates: [
    {
      id: "phone",
      label: "手机",
      description: "手机商品",
      category: "electronics.phone",
      supplyFields: [],
    },
    {
      id: "tablet",
      label: "平板",
      description: "平板商品",
      category: "electronics.tablet",
      supplyFields: [],
    },
  ],
  enabledTemplateIds: ["phone"],
  defaultTemplateId: "phone",
};

const baseProps = {
  storeId: "store-1",
  catalog,
  loading: false,
  error: null,
  onReload: vi.fn(),
  onCatalogChange: vi.fn(),
  onNotice: vi.fn(),
  locale: "zh" as const,
};

describe("StoreProductTemplateSettings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is read-only for an operator", () => {
    render(
      <StoreProductTemplateSettings {...baseProps} canManageStore={false} />,
    );
    expect(screen.getByRole("checkbox", { name: /手机/ })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /平板/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "保存模板设置" })).toBeNull();
    expect(screen.getByText(/只有店主或管理员/)).toBeInTheDocument();
  });

  it("saves enabled and default choices with both optimistic versions", async () => {
    const saved = {
      ...catalog,
      storeVersion: 8,
      enabledTemplateIds: ["phone", "tablet"],
      defaultTemplateId: "tablet",
    };
    api.saveStoreProductTemplates.mockResolvedValue(saved);
    render(
      <StoreProductTemplateSettings {...baseProps} canManageStore={true} />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /平板/ }));
    fireEvent.change(screen.getByLabelText("默认商品模板"), {
      target: { value: "tablet" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存模板设置" }));

    await waitFor(() =>
      expect(api.saveStoreProductTemplates).toHaveBeenCalledWith({
        storeId: "store-1",
        enabledTemplateIds: ["phone", "tablet"],
        defaultTemplateId: "tablet",
        expectedStoreVersion: 7,
        expectedCatalogRevision: "revision-1",
      }),
    );
    expect(baseProps.onCatalogChange).toHaveBeenCalledWith(saved);
  });

  it("surfaces a 409 and only refreshes after the explicit action", async () => {
    api.saveStoreProductTemplates.mockRejectedValue(
      new MarketplaceApiError(409, "店铺或商品模板目录已更新"),
    );
    const { rerender } = render(
      <StoreProductTemplateSettings {...baseProps} canManageStore={true} />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /平板/ }));
    fireEvent.click(screen.getByRole("button", { name: "保存模板设置" }));

    const refresh = await screen.findByRole("button", {
      name: "刷新模板设置",
    });
    expect(baseProps.onReload).not.toHaveBeenCalled();
    fireEvent.click(refresh);
    expect(baseProps.onReload).toHaveBeenCalledTimes(1);

    rerender(
      <StoreProductTemplateSettings
        {...baseProps}
        catalog={{ ...catalog, storeVersion: 8 }}
        canManageStore={true}
      />,
    );
    expect(screen.getByRole("checkbox", { name: /平板/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "保存模板设置" })).toBeEnabled();
  });

  it("states that new publishing is paused when no template is enabled", () => {
    render(
      <StoreProductTemplateSettings
        {...baseProps}
        catalog={{
          ...catalog,
          enabledTemplateIds: [],
          defaultTemplateId: null,
        }}
        canManageStore={false}
      />,
    );
    expect(screen.getByText(/暂停发布新商品/)).toBeInTheDocument();
  });
});

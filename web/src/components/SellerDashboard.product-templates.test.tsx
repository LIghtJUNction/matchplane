import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  consentMarketplaceContact: vi.fn(),
  createMarketplaceOffer: vi.fn(),
  getMarketplaceIntroductions: vi.fn(async () => []),
  getMarketplaceDemandMatches: vi.fn(),
  getMarketplaceOffers: vi.fn(async (): Promise<unknown[]> => []),
  getSellerListingSubmissions: vi.fn(async () => []),
  getStoreProductTemplates: vi.fn(),
  isLiveMarketplaceEnabled: vi.fn(() => true),
  retrieveMarketplaceContact: vi.fn(),
  saveStoreProductTemplates: vi.fn(),
  submitSellerListing: vi.fn(),
  updateMarketplaceOffer: vi.fn(),
  uploadMarketplaceAttachment: vi.fn(),
  withdrawMarketplaceOffer: vi.fn(),
}));

vi.mock("../api", () => api);
vi.mock("../lib/marketplace-session", () => ({
  getMarketplaceSession: vi.fn(async () => ({
    tenantId: "11111111-1111-4111-8111-111111111111",
    partyId: "22222222-2222-4222-8222-222222222222",
    role: "seller",
    accessToken: "test-token",
    accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  })),
}));

import type {
  MarketplaceOffer,
  StoreProductTemplateCatalog,
  StoreSummary,
} from "../api";
import type { SubplatformConfig } from "../subplatform";
import { SellerDashboard } from "./SellerDashboard";

const subplatform = {
  slug: "my-store",
  path: "/my-store",
  label: "我的店铺",
  brandName: "我的店铺",
  tenantId: "11111111-1111-4111-8111-111111111111",
  domainId: "33333333-3333-4333-8333-333333333333",
  marketplaceContract: "generic-v1",
  pricing: { mode: "fixed", currency: "CNY", currencyScale: 2, label: "价格" },
  ui: {},
} as unknown as SubplatformConfig;
const store = {
  id: "44444444-4444-4444-8444-444444444444",
  slug: "my-store",
  path: "/my-store",
  displayName: "我的店铺",
  description: "",
  integrationKind: "hosted",
} satisfies StoreSummary;
const catalog: StoreProductTemplateCatalog = {
  storeId: store.id,
  storeVersion: 4,
  catalogRevision: "revision-4",
  enabledTemplateIds: ["phone", "tablet"],
  defaultTemplateId: "phone",
  templates: [
    {
      id: "phone",
      label: "手机",
      description: "手机字段",
      category: "electronics.phone",
      supplyFields: [
        { key: "brand", label: "品牌", type: "text", required: true },
        { key: "model", label: "型号", type: "text", required: true },
      ],
    },
    {
      id: "tablet",
      label: "平板",
      description: "平板字段",
      category: "electronics.tablet",
      supplyFields: [
        { key: "brand", label: "品牌", type: "text", required: true },
        { key: "model", label: "型号", type: "text", required: false },
        { key: "screen", label: "屏幕尺寸", type: "number", required: true },
      ],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getStoreProductTemplates.mockResolvedValue(catalog);
  api.getMarketplaceOffers.mockResolvedValue([]);
  api.getMarketplaceIntroductions.mockResolvedValue([]);
  api.uploadMarketplaceAttachment.mockResolvedValue({
    attachment_ref: "media://hosted/image",
    kind: "image",
    file_name: "product.png",
    media_type: "image/png",
    size_bytes: 5,
    sha256: "a".repeat(64),
    metadata: { public_url: "/api/store-media/image" },
  });
  api.createMarketplaceOffer.mockResolvedValue({
    offer_id: "55555555-5555-4555-8555-555555555555",
    tenant_id: subplatform.tenantId,
    domain_id: subplatform.domainId,
    supply_party_id: "22222222-2222-4222-8222-222222222222",
    external_key: "offer-test",
    display_name: "测试商品",
    attributes: {},
    terms: {},
    productTemplateId: "phone",
    status: "draft",
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    duplicate: false,
  });
});

function renderDashboard() {
  return render(
    <SellerDashboard
      locale="zh"
      onNotice={vi.fn()}
      subplatform={subplatform}
      store={store}
      canManageStore
    />,
  );
}

async function openPublisher() {
  const publish = (
    await screen.findAllByRole("button", {
      name: "发布商品",
    })
  )[0]!;
  await waitFor(() => expect(publish).toBeEnabled());
  fireEvent.click(publish);
  await screen.findByLabelText("选择商品模板");
}

function marketplaceOffer(
  productTemplateId: string | null,
  attributes: Record<string, unknown>,
): MarketplaceOffer {
  const now = new Date().toISOString();
  return {
    offer_id: `offer-${productTemplateId ?? "legacy"}`,
    tenant_id: subplatform.tenantId as string,
    domain_id: subplatform.domainId as string,
    supply_party_id: "party",
    external_key: `key-${productTemplateId ?? "legacy"}`,
    display_name: "旧商品",
    attributes,
    terms: { amount_minor: "100", currency: "CNY", currency_scale: 2 },
    productTemplateId,
    status: "draft",
    version: 2,
    created_at: now,
    updated_at: now,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("SellerDashboard product templates", () => {
  it("preselects the store default for a new product", async () => {
    renderDashboard();
    await openPublisher();
    expect(screen.getByLabelText("选择商品模板")).toHaveValue("phone");
    expect(screen.getByLabelText("商品分类")).toHaveValue("electronics.phone");
    expect(screen.getByLabelText("品牌")).toBeInTheDocument();
  });

  it("does not clear fields until a template switch is confirmed", async () => {
    renderDashboard();
    await openPublisher();
    fireEvent.change(screen.getByLabelText("品牌"), {
      target: { value: "Acme" },
    });
    fireEvent.change(screen.getByLabelText("型号"), {
      target: { value: "One" },
    });
    fireEvent.change(screen.getByLabelText("选择商品模板"), {
      target: { value: "tablet" },
    });
    expect(screen.getByLabelText("型号")).toHaveValue("One");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.getByLabelText("型号")).toHaveValue("One");

    fireEvent.change(screen.getByLabelText("选择商品模板"), {
      target: { value: "tablet" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认切换" }));
    expect(screen.getByLabelText("品牌")).toHaveValue("Acme");
    expect(screen.getByLabelText("型号")).toHaveValue("");
    expect(screen.getByLabelText("商品分类")).toHaveValue("electronics.tablet");
  });

  it("submits the template id atomically with only target template fields", async () => {
    const user = userEvent.setup();
    renderDashboard();
    await openPublisher();
    fireEvent.change(screen.getByLabelText("品牌"), {
      target: { value: "Acme" },
    });
    fireEvent.change(screen.getByLabelText("型号"), {
      target: { value: "One" },
    });
    fireEvent.change(screen.getByLabelText("选择商品模板"), {
      target: { value: "tablet" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认切换" }));
    fireEvent.change(screen.getByLabelText("屏幕尺寸"), {
      target: { value: "12" },
    });

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await user.upload(
      fileInput,
      new File(["image"], "product.png", { type: "image/png" }),
    );
    await user.type(screen.getByLabelText("商品名称"), "测试平板");
    await user.type(screen.getByLabelText("商品描述"), "真实商品描述");
    await user.type(screen.getByLabelText(/价格/), "99");
    await user.selectOptions(screen.getByLabelText("交付方式"), "shipping");
    fireEvent.click(screen.getByRole("button", { name: "上传并提交审核" }));

    await waitFor(() => expect(api.createMarketplaceOffer).toHaveBeenCalled());
    expect(api.createMarketplaceOffer).toHaveBeenCalledWith(
      expect.objectContaining({
        productTemplateId: "tablet",
        attributes: expect.objectContaining({
          category: "electronics.tablet",
          brand: "Acme",
          screen: 12,
        }),
      }),
    );
    expect(
      api.createMarketplaceOffer.mock.calls[0]?.[0].attributes.model,
    ).toBeUndefined();
  });

  it("recovers an unknown offer through an explicit enabled replacement", async () => {
    api.getMarketplaceOffers.mockResolvedValue([
      marketplaceOffer("missing-template", {
        category: "legacy",
        description: "旧描述",
        brand: "Acme",
      }),
    ]);
    renderDashboard();
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));

    expect(screen.getByText(/不存在的模板/)).toBeInTheDocument();
    expect(screen.getByLabelText("商品描述")).toHaveValue("旧描述");
    const replacement = screen.getByLabelText("选择商品模板");
    expect(replacement).toHaveValue("");
    expect(
      within(replacement).getByRole("option", { name: "手机" }),
    ).toBeInTheDocument();
    expect(
      within(replacement).getByRole("option", { name: "平板" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "保存并重新提交审核" }),
    ).toBeDisabled();

    fireEvent.change(replacement, { target: { value: "phone" } });
    expect(screen.getByText("清除原模板字段").nextSibling).toHaveTextContent(
      "brand",
    );
    fireEvent.click(screen.getByRole("button", { name: "确认切换" }));
    expect(screen.getByLabelText("品牌")).toHaveValue("");
    expect(screen.getByLabelText("型号")).toHaveValue("");
    expect(screen.getByLabelText("商品描述")).toHaveValue("旧描述");
    expect(screen.getByLabelText("商品分类")).toHaveValue("electronics.phone");
  });

  it("recovers a legacy null offer only after an explicit replacement", async () => {
    api.getMarketplaceOffers.mockResolvedValue([
      marketplaceOffer(null, {
        category: "legacy",
        description: "旧版草稿",
        brand: "Legacy brand",
      }),
    ]);
    renderDashboard();
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));

    expect(screen.getByText(/未绑定商品模板/)).toBeInTheDocument();
    const replacement = screen.getByLabelText("选择商品模板");
    expect(replacement).toHaveValue("");
    expect(
      within(replacement).getByRole("option", { name: "手机" }),
    ).toBeInTheDocument();
    expect(
      within(replacement).getByRole("option", { name: "平板" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "保存并重新提交审核" }),
    ).toBeDisabled();

    fireEvent.change(replacement, { target: { value: "phone" } });
    expect(screen.getByText("清除原模板字段").nextSibling).toHaveTextContent(
      "brand",
    );
    fireEvent.click(screen.getByRole("button", { name: "确认切换" }));
    expect(screen.getByLabelText("品牌")).toHaveValue("");
    expect(screen.getByLabelText("商品描述")).toHaveValue("旧版草稿");
  });

  it("keeps compatible values while replacing a disabled template", async () => {
    api.getStoreProductTemplates.mockResolvedValue({
      ...catalog,
      storeVersion: 5,
      catalogRevision: "revision-5",
      enabledTemplateIds: ["tablet"],
      defaultTemplateId: "tablet",
    });
    api.getMarketplaceOffers.mockResolvedValue([
      marketplaceOffer("phone", {
        category: "electronics.phone",
        description: "待恢复草稿",
        brand: "Acme",
        model: "One",
      }),
    ]);
    renderDashboard();
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));

    expect(screen.getByText(/已被本店停用/)).toBeInTheDocument();
    expect(screen.getByLabelText("品牌")).toHaveValue("Acme");
    expect(screen.getByLabelText("型号")).toHaveValue("One");
    const replacement = screen.getByLabelText("选择商品模板");
    expect(
      within(replacement).queryByRole("option", { name: "手机" }),
    ).not.toBeInTheDocument();
    expect(
      within(replacement).getByRole("option", { name: "平板" }),
    ).toBeInTheDocument();

    fireEvent.change(replacement, { target: { value: "tablet" } });
    expect(screen.getByText("保留共享字段").nextSibling).toHaveTextContent(
      "品牌",
    );
    expect(screen.getByText("清除原模板字段").nextSibling).toHaveTextContent(
      "型号",
    );
    fireEvent.click(screen.getByRole("button", { name: "确认切换" }));

    expect(screen.getByLabelText("品牌")).toHaveValue("Acme");
    expect(screen.getByLabelText("型号")).toHaveValue("");
    expect(screen.getByLabelText("商品描述")).toHaveValue("待恢复草稿");
    expect(screen.getByLabelText("商品分类")).toHaveValue("electronics.tablet");
  });

  it("keeps a new-product draft during refresh and never follows a changed default", async () => {
    renderDashboard();
    await openPublisher();
    fireEvent.change(screen.getByLabelText("商品名称"), {
      target: { value: "未完成商品" },
    });
    fireEvent.change(screen.getByLabelText("商品描述"), {
      target: { value: "不要丢失的草稿" },
    });
    fireEvent.change(screen.getByLabelText("品牌"), {
      target: { value: "Acme" },
    });
    fireEvent.change(screen.getByLabelText("型号"), {
      target: { value: "One" },
    });

    const pendingCatalog = deferred<StoreProductTemplateCatalog>();
    api.getStoreProductTemplates.mockReturnValueOnce(pendingCatalog.promise);
    const refresh = screen.getByRole("button", { name: "刷新模板设置" });
    refresh.focus();
    fireEvent.click(refresh);

    expect(screen.getByRole("button", { name: "正在刷新模板…" })).toBe(refresh);
    expect(screen.getByLabelText("品牌")).toHaveValue("Acme");
    expect(screen.getByLabelText("型号")).toHaveValue("One");
    expect(screen.getByLabelText("商品名称")).toHaveValue("未完成商品");
    expect(
      screen.getByRole("button", { name: "上传并提交审核" }),
    ).toBeDisabled();

    pendingCatalog.resolve({
      ...catalog,
      storeVersion: 5,
      catalogRevision: "revision-5",
      enabledTemplateIds: ["tablet"],
      defaultTemplateId: "tablet",
    });
    await waitFor(() =>
      expect(screen.getByText(/已被本店停用/)).toBeInTheDocument(),
    );

    expect(screen.getByLabelText("品牌")).toHaveValue("Acme");
    expect(screen.getByLabelText("型号")).toHaveValue("One");
    expect(screen.getByLabelText("商品名称")).toHaveValue("未完成商品");
    expect(screen.getByLabelText("商品描述")).toHaveValue("不要丢失的草稿");
    expect(screen.getByLabelText("商品分类")).toHaveValue("electronics.phone");
    expect(screen.getByLabelText("选择商品模板")).toHaveValue("");
    expect(refresh).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "上传并提交审核" }),
    ).toBeDisabled();
  });

  it("keeps the current draft on refresh errors and exposes a retry", async () => {
    renderDashboard();
    await openPublisher();
    fireEvent.change(screen.getByLabelText("商品名称"), {
      target: { value: "错误恢复草稿" },
    });
    fireEvent.change(screen.getByLabelText("品牌"), {
      target: { value: "Acme" },
    });

    api.getStoreProductTemplates.mockRejectedValueOnce(
      new Error("网络暂时不可用"),
    );
    fireEvent.click(screen.getByRole("button", { name: "刷新模板设置" }));
    await screen.findAllByText("网络暂时不可用");

    expect(screen.getByLabelText("商品名称")).toHaveValue("错误恢复草稿");
    expect(screen.getByLabelText("品牌")).toHaveValue("Acme");
    expect(
      screen.getByRole("button", { name: "上传并提交审核" }),
    ).toBeDisabled();
    const retry = screen.getByRole("button", { name: "重试加载模板" });
    api.getStoreProductTemplates.mockResolvedValueOnce(catalog);
    fireEvent.click(retry);
    await waitFor(() => expect(retry).toHaveTextContent("刷新模板设置"));
    expect(screen.getByLabelText("商品名称")).toHaveValue("错误恢复草稿");
    expect(screen.getByLabelText("品牌")).toHaveValue("Acme");
  });

  it("keeps the legacy supply-field editor when no store policy is provided", async () => {
    const legacy = {
      ...subplatform,
      ui: {
        supplyFields: [
          {
            key: "legacy_code",
            label: "旧版编码",
            type: "text",
            required: true,
          },
        ],
      },
    } as unknown as SubplatformConfig;
    render(
      <SellerDashboard locale="zh" onNotice={vi.fn()} subplatform={legacy} />,
    );
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "发布商品" }))[0]!,
    );
    expect(screen.queryByText("商品模板")).not.toBeInTheDocument();
    expect(screen.getByLabelText("旧版编码")).toBeInTheDocument();
    expect(api.getStoreProductTemplates).not.toHaveBeenCalled();
  });
});

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  consentMarketplaceContact: vi.fn(),
  createMarketplaceOffer: vi.fn(),
  getMarketplaceIntroductions: vi.fn(async () => []),
  getMarketplaceDemandMatches: vi.fn(),
  getMarketplaceOffers: vi.fn(async (): Promise<unknown[]> => []),
  getSellerListingSubmissions: vi.fn(async () => []),
  isLiveMarketplaceEnabled: vi.fn(() => true),
  retrieveMarketplaceContact: vi.fn(),
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

import type { MarketplaceAttachment } from "../api";
import type { SubplatformConfig } from "../subplatform";
import { SellerDashboard } from "./SellerDashboard";

const baseSubplatform = {
  slug: "vehicle-store",
  path: "/vehicle-store",
  label: "车源店铺",
  brandName: "车源店铺",
  tenantId: "11111111-1111-4111-8111-111111111111",
  domainId: "33333333-3333-4333-8333-333333333333",
  marketplaceContract: "generic-v1",
  pricing: {
    mode: "fixed",
    currency: "CNY",
    currencyScale: 2,
    label: "价格",
  },
  ui: {},
} as unknown as SubplatformConfig;

const groupedSupplyFields = [
  {
    key: "vehicle.brand",
    label: "品牌",
    type: "select",
    required: true,
    group: "车辆识别",
    placeholder: "选择品牌",
    options: ["红旗", "大众"],
  },
  {
    key: "vehicle.mileage_km",
    label: "表显里程",
    type: "number",
    required: true,
    group: "车辆识别",
    help: "填写当前仪表显示的公里数",
    unit: "公里",
    min: 0,
    max: 1_000_000,
    step: 1,
  },
  {
    key: "vehicle.registered_on",
    label: "上牌日期",
    type: "date",
    group: "车辆识别",
  },
  {
    key: "vehicle.condition",
    label: "公开车况",
    type: "textarea",
    required: true,
    group: "车况与证明",
    help: "只填写可向买家公开的信息",
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.getMarketplaceOffers.mockResolvedValue([]);
  api.getMarketplaceIntroductions.mockResolvedValue([]);
  api.uploadMarketplaceAttachment.mockImplementation(
    async ({ file }: { file: File }) => attachmentFor(file.name),
  );
  api.createMarketplaceOffer.mockResolvedValue(createdOffer());
});

describe("SellerDashboard manifest-driven supply fields", () => {
  it("renders grouped select, number, date, and textarea fields with completion feedback", async () => {
    const user = userEvent.setup();
    renderDashboard({ subplatform: withSupplyFields(groupedSupplyFields) });

    await openCreateEditor(user);

    expect(screen.getByText("车辆识别")).toBeInTheDocument();
    expect(screen.getByText("车况与证明")).toBeInTheDocument();
    expect(screen.getAllByText(/完成度/).length).toBeGreaterThan(0);

    const brand = screen.getByLabelText(/^品牌/);
    expect(brand.tagName).toBe("SELECT");
    expect(
      within(brand).getByRole("option", { name: "红旗" }),
    ).toBeInTheDocument();

    expect(screen.getByLabelText(/^表显里程/)).toHaveAttribute(
      "type",
      "number",
    );
    expect(screen.getByLabelText(/^上牌日期/)).toHaveAttribute("type", "date");
    expect(screen.getByLabelText(/^公开车况/).tagName).toBe("TEXTAREA");
    expect(screen.getByText("填写当前仪表显示的公里数")).toBeInTheDocument();
    expect(screen.getByText("公里")).toBeInTheDocument();
  });

  it("blocks creation and names the first missing required manifest field", async () => {
    const user = userEvent.setup();
    const onNotice = vi.fn();
    renderDashboard({
      onNotice,
      subplatform: withSupplyFields([
        {
          key: "vehicle.brand",
          label: "品牌",
          type: "select",
          required: true,
          options: ["红旗", "大众"],
        },
      ]),
    });

    await openCreateEditor(user);
    await uploadImages(user, [imageFile("cover.png")]);
    await fillGenericFields(user);

    const submitButton = screen.getByRole("button", {
      name: "上传并提交审核",
    });
    const form = submitButton.closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("品牌")),
    );
    expect(api.createMarketplaceOffer).not.toHaveBeenCalled();
  });

  it("serializes typed public fields beside canonical terms, stock, and attachments", async () => {
    const user = userEvent.setup();
    renderDashboard({ subplatform: withSupplyFields(groupedSupplyFields) });

    await openCreateEditor(user);
    await uploadImages(user, [imageFile("cover.png")]);
    await fillGenericFields(user, {
      name: "  2024 款测试车  ",
      category: "  二手车  ",
      description: "  公开车辆描述  ",
      stock: "3",
      amount: "19.80",
    });
    await user.selectOptions(screen.getByLabelText(/^品牌/), "红旗");
    await user.type(screen.getByLabelText(/^表显里程/), "12800");
    await user.type(screen.getByLabelText(/^上牌日期/), "2024-06-18");
    await user.type(
      screen.getByLabelText(/^公开车况/),
      "  原版原漆，正常使用  ",
    );
    await user.click(screen.getByRole("button", { name: "上传并提交审核" }));

    await waitFor(() => expect(api.createMarketplaceOffer).toHaveBeenCalled());
    const request = api.createMarketplaceOffer.mock.calls[0]![0];
    expect(request).toEqual(
      expect.objectContaining({
        displayName: "2024 款测试车",
        attributes: expect.objectContaining({
          description: "公开车辆描述",
          category: "二手车",
          delivery_mode: "shipping",
          stock_quantity: 3,
          "vehicle.brand": "红旗",
          "vehicle.mileage_km": 12800,
          "vehicle.registered_on": "2024-06-18",
          "vehicle.condition": "原版原漆，正常使用",
          attachments: [publicAttachmentFor("cover.png")],
        }),
        terms: {
          pricing_mode: "fixed",
          amount_minor: "1980",
          currency: "CNY",
          currency_scale: 2,
        },
      }),
    );
  });

  it("prefills declared fields, preserves opaque attributes, and removes a cleared optional field", async () => {
    const user = userEvent.setup();
    const existing = editableOffer({
      "vehicle.brand": "大众",
      "vehicle.condition": "原车主公开说明",
      opaque_from_adapter: { source: "dealer-dms", revision: 7 },
    });
    api.getMarketplaceOffers.mockResolvedValueOnce([existing]);
    api.updateMarketplaceOffer.mockResolvedValueOnce({
      ...existing,
      status: "draft",
      version: existing.version + 1,
    });
    renderDashboard({
      subplatform: withSupplyFields([
        {
          key: "vehicle.brand",
          label: "品牌",
          type: "select",
          required: true,
          options: ["红旗", "大众"],
        },
        {
          key: "vehicle.condition",
          label: "公开车况",
          type: "textarea",
        },
      ]),
    });

    await user.click(await screen.findByRole("button", { name: "编辑" }));
    expect(screen.getByLabelText(/^品牌/)).toHaveValue("大众");
    expect(screen.getByLabelText(/^公开车况/)).toHaveValue("原车主公开说明");

    await user.selectOptions(screen.getByLabelText(/^品牌/), "红旗");
    await user.clear(screen.getByLabelText(/^公开车况/));
    await user.click(
      screen.getByRole("button", { name: "保存并重新提交审核" }),
    );

    await waitFor(() => expect(api.updateMarketplaceOffer).toHaveBeenCalled());
    const request = api.updateMarketplaceOffer.mock.calls[0]![0];
    expect(request.attributes).toEqual(
      expect.objectContaining({
        "vehicle.brand": "红旗",
        opaque_from_adapter: { source: "dealer-dms", revision: 7 },
      }),
    );
    expect(request.attributes).not.toHaveProperty("vehicle.condition");
  });

  it("keeps successful images in selection order after a middle failure and lets another image become the cover", async () => {
    const user = userEvent.setup();
    const onNotice = vi.fn();
    api.uploadMarketplaceAttachment.mockImplementation(
      async ({ file }: { file: File }) => {
        if (file.name === "second.png") throw new Error("second.png 上传失败");
        return attachmentFor(file.name);
      },
    );
    renderDashboard({ onNotice, subplatform: baseSubplatform });

    await openCreateEditor(user);
    await uploadImages(user, [
      imageFile("first.png"),
      imageFile("second.png"),
      imageFile("third.png"),
    ]);

    const mediaList = await screen.findByRole("list", {
      name: "已上传的图片",
    });
    const mediaItems = within(mediaList).getAllByRole("listitem");
    expect(mediaItems.map((item) => item.textContent)).toEqual([
      expect.stringContaining("first.png"),
      expect.stringContaining("third.png"),
    ]);
    expect(screen.queryByText("second.png")).not.toBeInTheDocument();
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining("失败"));

    await user.click(
      within(mediaItems[1]!).getByRole("button", { name: "设为封面" }),
    );
    await fillGenericFields(user);
    await user.click(screen.getByRole("button", { name: "上传并提交审核" }));

    await waitFor(() => expect(api.createMarketplaceOffer).toHaveBeenCalled());
    const request = api.createMarketplaceOffer.mock.calls[0]![0];
    expect(
      request.attributes.attachments.map(
        (attachment: MarketplaceAttachment) => attachment.file_name,
      ),
    ).toEqual(["third.png", "first.png"]);
  });

  it("shows an immediate busy state and blocks conflicting actions while media uploads", async () => {
    const user = userEvent.setup();
    let finishUpload: ((attachment: MarketplaceAttachment) => void) | null =
      null;
    api.uploadMarketplaceAttachment.mockImplementationOnce(
      () =>
        new Promise<MarketplaceAttachment>((resolve) => {
          finishUpload = resolve;
        }),
    );
    renderDashboard({ subplatform: baseSubplatform });

    await openCreateEditor(user);
    await uploadImages(user, [imageFile("waiting.png")]);

    expect(
      await screen.findByRole("button", { name: "上传中…" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "上传并提交审核" }),
    ).toBeDisabled();

    expect(finishUpload).not.toBeNull();
    finishUpload!(attachmentFor("waiting.png"));
    expect(
      await screen.findByRole("button", { name: "继续添加图片" }),
    ).toBeEnabled();
  });

  it("keeps the generic publishing form working when no supply fields are declared", async () => {
    const user = userEvent.setup();
    renderDashboard({ subplatform: baseSubplatform });

    await openCreateEditor(user);
    expect(screen.queryByText(/资料完成度/)).not.toBeInTheDocument();
    await uploadImages(user, [imageFile("generic.png")]);
    await fillGenericFields(user, { name: "通用商品" });
    await user.click(screen.getByRole("button", { name: "上传并提交审核" }));

    await waitFor(() => expect(api.createMarketplaceOffer).toHaveBeenCalled());
    expect(api.createMarketplaceOffer).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "通用商品",
        attributes: expect.objectContaining({
          category: "通用分类",
          description: "真实商品描述",
          delivery_mode: "shipping",
          stock_quantity: 2,
          attachments: [publicAttachmentFor("generic.png")],
        }),
      }),
    );
  });
});

function renderDashboard({
  onNotice = vi.fn(),
  subplatform,
}: {
  onNotice?: (message: string) => void;
  subplatform: SubplatformConfig;
}) {
  return render(
    <SellerDashboard
      locale="zh"
      onNotice={onNotice}
      subplatform={subplatform}
    />,
  );
}

function withSupplyFields(fields: unknown[]): SubplatformConfig {
  return {
    ...baseSubplatform,
    ui: { supplyFields: fields },
  } as unknown as SubplatformConfig;
}

async function openCreateEditor(user: UserEvent) {
  await screen.findByRole("heading", { name: "商品列表" });
  await user.click(screen.getAllByRole("button", { name: "发布商品" })[0]!);
  expect(
    await screen.findByRole("heading", { name: "发布商品" }),
  ).toBeInTheDocument();
}

async function uploadImages(user: UserEvent, files: File[]) {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).not.toBeNull();
  await user.upload(input!, files);
}

async function fillGenericFields(
  user: UserEvent,
  values: {
    name?: string;
    category?: string;
    description?: string;
    amount?: string;
    stock?: string;
  } = {},
) {
  await user.type(screen.getByLabelText("商品名称"), values.name ?? "测试商品");
  await user.type(
    screen.getByLabelText("商品分类"),
    values.category ?? "通用分类",
  );
  await user.type(
    screen.getByLabelText("商品描述"),
    values.description ?? "真实商品描述",
  );
  await user.type(screen.getByLabelText(/价格/), values.amount ?? "99.00");
  await user.selectOptions(screen.getByLabelText("交付方式"), "shipping");
  await user.clear(screen.getByLabelText(/可售库存/));
  await user.type(screen.getByLabelText(/可售库存/), values.stock ?? "2");
}

function imageFile(name: string) {
  return new File([`image:${name}`], name, { type: "image/png" });
}

function attachmentFor(fileName: string): MarketplaceAttachment {
  const id = fileName.padEnd(32, "0").slice(0, 32);
  return {
    attachment_ref: `media://hosted/${id}`,
    kind: "image",
    file_name: fileName,
    media_type: "image/webp",
    size_bytes: 100,
    sha256: fileName.charCodeAt(0).toString(16).padStart(64, "0").slice(-64),
    width: 1200,
    height: 800,
    metadata: {
      public_url: `/api/store-media/${encodeURIComponent(fileName)}`,
    },
  };
}

function publicAttachmentFor(fileName: string) {
  return { ...attachmentFor(fileName) };
}

function createdOffer() {
  return {
    offer_id: "55555555-5555-4555-8555-555555555555",
    tenant_id: baseSubplatform.tenantId,
    domain_id: baseSubplatform.domainId,
    supply_party_id: "22222222-2222-4222-8222-222222222222",
    external_key: "offer-test",
    display_name: "测试商品",
    attributes: {},
    terms: {},
    status: "draft",
    version: 1,
    created_at: "2026-08-30T00:00:00Z",
    updated_at: "2026-08-30T00:00:00Z",
    duplicate: false,
  };
}

function editableOffer(extraAttributes: Record<string, unknown>) {
  return {
    offer_id: "44444444-4444-4444-8444-444444444444",
    tenant_id: baseSubplatform.tenantId,
    domain_id: baseSubplatform.domainId,
    supply_party_id: "22222222-2222-4222-8222-222222222222",
    asset_id: null,
    external_key: "vehicle-1",
    display_name: "可编辑车源",
    attributes: {
      description: "公开车辆描述",
      category: "二手车",
      delivery_mode: "shipping",
      stock_quantity: 1,
      attachments: [publicAttachmentFor("existing.png")],
      ...extraAttributes,
    },
    terms: {
      pricing_mode: "fixed",
      amount_minor: "1234000",
      currency: "CNY",
      currency_scale: 2,
    },
    status: "active",
    published_at: "2026-08-29T00:00:00Z",
    expires_at: null,
    version: 4,
    created_at: "2026-08-29T00:00:00Z",
    updated_at: "2026-08-30T00:00:00Z",
  };
}

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadLanding: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("next/navigation", () => ({ notFound: mocks.notFound }));
vi.mock("../../../src/lib/acquisition-landing", () => ({
  loadAcquisitionLanding: mocks.loadLanding,
}));

import VisitLandingPage, {
  dynamic,
  fetchCache,
  metadata,
  revalidate,
} from "./page";

const landing = {
  offerId: "55555555-5555-4555-8555-555555555555",
  displayName: "旅行相机",
  description: "轻巧机身，适合随身记录。",
  status: "active" as const,
  updatedAt: "2026-08-30T12:34:56.000Z",
  price: {
    amountMinor: "129900",
    currency: "CNY",
    currencyScale: 2,
  },
  media: [
    { url: "https://images.example.test/camera-front.jpg" },
    { url: "https://images.example.test/camera-back.jpg" },
  ],
  fields: [
    {
      key: "location",
      label: "所在地区",
      group: "交付",
      unit: null,
      value: "上海",
    },
    {
      key: "sensor_size",
      label: "传感器规格",
      group: "成像",
      unit: null,
      value: "全画幅",
    },
    {
      key: "notes",
      label: "商品补充说明",
      group: "成像",
      unit: null,
      value: "这是一段可以自动换行的很长商品说明，用来验证页面不会依赖固定长度字段。",
    },
  ],
  store: {
    name: "相机屋",
    description: "相机与镜头",
    path: "/camera-house",
  },
  primaryHref:
    "/camera-house?offer=55555555-5555-4555-8555-555555555555",
  storeHref: "/camera-house",
};

beforeEach(() => {
  mocks.loadLanding.mockReset();
  mocks.notFound.mockClear();
});

describe("/visit/[token] buyer landing page", () => {
  it("renders source continuity, public media, grouped manifest fields, merchant, and canonical CTAs", async () => {
    mocks.loadLanding.mockResolvedValue(landing);

    render(
      await VisitLandingPage({
        params: Promise.resolve({ token: "AAAAAAAAAAAAAAAAAAAAAA" }),
      }),
    );

    expect(screen.getByText("已接上刚才的推荐")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "旅行相机" }),
    ).toBeInTheDocument();
    expect(screen.getByText("在售")).toBeInTheDocument();
    expect(screen.getByText(/1,299\.00/)).toBeInTheDocument();
    expect(screen.getAllByRole("img")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: "交付" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "成像" })).toBeInTheDocument();
    expect(screen.getAllByText("所在地区")).toHaveLength(2);
    expect(screen.getByText("传感器规格")).toBeInTheDocument();
    expect(
      screen.getByText(/这是一段可以自动换行的很长商品说明/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "到店铺继续查看" }),
    ).toHaveAttribute("href", landing.primaryHref);
    expect(screen.getByRole("link", { name: "返回店铺" })).toHaveAttribute(
      "href",
      landing.storeHref,
    );
    expect(screen.getByRole("heading", { name: "相机屋" })).toBeInTheDocument();
    for (const image of screen.getAllByRole("img")) {
      expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
    }
  });

  it("keeps a useful empty-media state without inventing a product image", async () => {
    mocks.loadLanding.mockResolvedValue({ ...landing, media: [] });

    render(
      await VisitLandingPage({
        params: Promise.resolve({ token: "AAAAAAAAAAAAAAAAAAAAAA" }),
      }),
    );

    expect(
      screen.getByRole("img", { name: "暂无商品图片" }),
    ).toBeInTheDocument();
    expect(screen.getByText("图片待补充")).toBeInTheDocument();
  });

  it.each(["invalid token", "expired link", "inactive offer or store"])(
    "collapses %s to the same not-found boundary",
    async () => {
      mocks.loadLanding.mockResolvedValue(null);

      await expect(
        VisitLandingPage({
          params: Promise.resolve({ token: "unavailable" }),
        }),
      ).rejects.toThrow("NEXT_NOT_FOUND");
      expect(mocks.notFound).toHaveBeenCalledWith();
    },
  );

  it("collapses loader failures to the same not-found boundary", async () => {
    mocks.loadLanding.mockRejectedValue(new Error("database unavailable"));

    await expect(
      VisitLandingPage({
        params: Promise.resolve({ token: "AAAAAAAAAAAAAAAAAAAAAA" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.notFound).toHaveBeenCalledWith();
  });

  it("declares dynamic no-store rendering with noindex, nofollow, and no referrer", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(revalidate).toBe(0);
    expect(fetchCache).toBe("force-no-store");
    expect(metadata.robots).toEqual(
      expect.objectContaining({ index: false, follow: false }),
    );
    expect(metadata.referrer).toBe("no-referrer");
  });
});

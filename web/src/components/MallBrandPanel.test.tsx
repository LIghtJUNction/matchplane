import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getMallLegalDocuments: vi.fn(async () => ({
    mallName: "MatchPlane",
    documents: {
      terms: { content: "默认用户协议", version: 2, updatedAt: "2026-08-21T00:00:00.000Z" },
      privacy: { content: "默认隐私政策", version: 4, updatedAt: "2026-08-21T00:00:00.000Z" },
    },
  })),
  getMallSettings: vi.fn(async () => ({ name: "MatchPlane", slug: "matchplane", version: 3, logoUrl: null })),
  saveMallLegalDocuments: vi.fn(),
  saveMallSettings: vi.fn(async ({ name, expectedVersion }: { name: string; expectedVersion: number }) => ({ name, slug: "matchplane", version: expectedVersion + 1, logoUrl: null })),
  uploadMallBrandLogo: vi.fn(),
}));

vi.mock("../api", () => api);

import { MallBrandPanel } from "./MallBrandPanel";

afterEach(() => vi.clearAllMocks());

describe("MallBrandPanel", () => {
  it("saves the configured public mall name", async () => {
    const user = userEvent.setup();
    render(<MallBrandPanel rootRole="rootSuperAdmin" onNotice={vi.fn()} />);

    const name = await screen.findByLabelText("品牌名");
    await user.clear(name);
    await user.type(name, "新商城");
    await user.click(screen.getByRole("button", { name: "保存品牌" }));

    expect(api.saveMallSettings).toHaveBeenCalledWith({ name: "新商城", expectedVersion: 3 });
  });

  it("shows the public policy paths and edits the seeded templates", async () => {
    render(<MallBrandPanel rootRole="rootSuperAdmin" onNotice={vi.fn()} />);

    expect(await screen.findByText(/公开路径/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "/terms" })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: "/privacy" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByLabelText("用户协议")).toHaveValue("默认用户协议");
    expect(screen.getByLabelText("隐私政策")).toHaveValue("默认隐私政策");
  });
});

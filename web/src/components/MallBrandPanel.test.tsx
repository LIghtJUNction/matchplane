import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getMallSettings: vi.fn(async () => ({ name: "MatchPlane", slug: "matchplane", version: 3, logoUrl: null })),
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
});

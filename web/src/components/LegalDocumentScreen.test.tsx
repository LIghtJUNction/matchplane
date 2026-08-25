import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getMallLegalDocuments: vi.fn(async () => ({
    mallName: "新商城",
    documents: {
      terms: {
        content: "欢迎使用 {{mall_name}}。",
        version: 1,
        updatedAt: "2026-08-21T00:00:00.000Z",
      },
      privacy: {
        content: "{{mall_name}} 会保护你的信息。",
        version: 1,
        updatedAt: "2026-08-21T00:00:00.000Z",
      },
    },
  })),
}));

vi.mock("../api", () => api);

import { LegalDocumentScreen } from "./LegalDocumentScreen";

afterEach(() => vi.clearAllMocks());

describe("LegalDocumentScreen", () => {
  it("serves the editable public privacy policy at its own page", async () => {
    render(<LegalDocumentScreen kind="privacy" />);

    expect(
      await screen.findByRole("heading", { name: "隐私政策" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("新商城 会保护你的信息。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回商城" })).toHaveAttribute(
      "href",
      "/",
    );
  });

  it("offers an in-place retry when the current legal document cannot load", async () => {
    api.getMallLegalDocuments.mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    render(<LegalDocumentScreen kind="terms" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "协议内容暂时无法读取，请稍后重试。",
    );
    expect(screen.queryByText(/欢迎使用/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重新加载" }));

    expect(await screen.findByText("欢迎使用 新商城。")).toBeInTheDocument();
    expect(api.getMallLegalDocuments).toHaveBeenCalledTimes(2);
  });
});

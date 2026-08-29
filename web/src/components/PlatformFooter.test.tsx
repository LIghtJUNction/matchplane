import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getPublicPlatformSiteSettings: vi.fn(async () => ({
    icp_number: null,
    icp_record_url: null,
    public_security_number: null,
    public_security_url: null,
  })),
}));

vi.mock("../api", () => api);

import { PlatformFooter } from "./PlatformFooter";

afterEach(() => vi.clearAllMocks());

describe("PlatformFooter", () => {
  it("exposes the public how-to-shop page from the root mall footer", async () => {
    render(
      <PlatformFooter
        subplatform={{
          slug: "root",
          path: "/",
          brandName: "MatchPlane",
          label: "通用 AI 撮合",
          description: "把需求交给合适的供给方。",
        }}
      />,
    );

    expect(screen.getByRole("link", { name: "如何选购" })).toHaveAttribute(
      "href",
      "/how",
    );
    expect(screen.getByRole("link", { name: "用户协议" })).toHaveAttribute(
      "href",
      "/terms",
    );
    expect(screen.getByRole("link", { name: "隐私政策" })).toHaveAttribute(
      "href",
      "/privacy",
    );
  });
});

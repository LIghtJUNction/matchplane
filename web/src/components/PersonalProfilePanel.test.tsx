import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getAccountProfile: vi.fn(async () => ({ name: "Test User", email: "test@example.test", image: null, bio: "" })),
  saveAccountProfile: vi.fn(async ({ bio }: { bio: string }) => ({ name: "Test User", email: "test@example.test", image: null, bio })),
  uploadAccountAvatar: vi.fn(),
}));

vi.mock("../api", () => api);

import { PersonalProfilePanel } from "./PersonalProfilePanel";

afterEach(() => vi.clearAllMocks());

describe("PersonalProfilePanel", () => {
  it("saves a personal bio without treating it as contact data", async () => {
    const user = userEvent.setup();
    render(<PersonalProfilePanel onAvatarChanged={vi.fn()} onNotice={vi.fn()} />);

    const bio = await screen.findByLabelText("个人简介");
    await user.type(bio, "爱好旅行和二手车");
    await user.click(screen.getByRole("button", { name: "保存个人资料" }));

    expect(api.saveAccountProfile).toHaveBeenCalledWith({ bio: "爱好旅行和二手车" });
  });
});

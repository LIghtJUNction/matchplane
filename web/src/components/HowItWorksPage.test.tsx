import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { HowItWorksPage } from "./HowItWorksPage";

afterEach(() => {
  window.localStorage.clear();
});

describe("HowItWorksPage", () => {
  it("explains public shopping and keeps the home chat as the primary action", async () => {
    render(<HowItWorksPage />);

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "说出需求，从真实店铺里挑。",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回商城" })).toHaveAttribute(
      "href",
      "/",
    );
    expect(
      screen.getByRole("link", { name: "去首页说说需求" }),
    ).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "登录后开店" })).toHaveAttribute(
      "href",
      "/login?next=%2F%3Fstores%3D1",
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

  it("renders English copy when the stored locale is English", async () => {
    window.localStorage.setItem("matchplane.locale", "en");
    render(<HowItWorksPage />);

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Tell the mall what you need, then pick from real stores.",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to mall" })).toHaveAttribute(
      "href",
      "/",
    );
    expect(
      screen.getByRole("link", { name: "Describe a need on the home page" }),
    ).toHaveAttribute("href", "/");
    expect(
      screen.getByRole("link", { name: "Sign in to open a store" }),
    ).toHaveAttribute("href", "/login?next=%2F%3Fstores%3D1");
  });

  it("lets a visitor switch language from the page controls", async () => {
    const user = userEvent.setup();
    render(<HowItWorksPage />);

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "说出需求，从真实店铺里挑。",
      }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "显示与语言" }));
    await user.click(screen.getByRole("button", { name: "English" }));

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Tell the mall what you need, then pick from real stores.",
      }),
    ).toBeInTheDocument();
  });
});

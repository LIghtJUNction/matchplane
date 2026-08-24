import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyInterfaceLocale,
  applyInterfacePalette,
  applyInterfaceTextSize,
  applyInterfaceTheme,
  useInterfacePreferences,
} from "./preferences";

function PreferencesHarness() {
  const preferences = useInterfacePreferences();
  return (
    <div
      data-testid="preferences"
      data-theme={preferences.theme}
      data-locale={preferences.locale}
      data-palette={preferences.palette}
      data-text-size={preferences.textSize}
    >
      <button
        type="button"
        onClick={() => {
          preferences.setTheme("light");
          preferences.setLocale("zh");
          preferences.setPalette("plum");
          preferences.setTextSize("small");
        }}
      >
        应用新偏好
      </button>
    </div>
  );
}

afterEach(() => {
  window.localStorage.clear();
  applyInterfaceTheme("light");
  applyInterfaceLocale("zh");
  applyInterfacePalette("ink");
  applyInterfaceTextSize("default");
});

describe("interface preference persistence", () => {
  it("restores and immediately applies palette, theme, text size, and locale", async () => {
    window.localStorage.setItem("matchplane.theme", "dark");
    window.localStorage.setItem("matchplane.locale", "en");
    window.localStorage.setItem("matchplane.palette", "moss");
    window.localStorage.setItem("matchplane.text-size", "large");
    const user = userEvent.setup();

    render(<PreferencesHarness />);
    const state = screen.getByTestId("preferences");

    await waitFor(() => {
      expect(state).toHaveAttribute("data-theme", "dark");
      expect(state).toHaveAttribute("data-locale", "en");
      expect(state).toHaveAttribute("data-palette", "moss");
      expect(state).toHaveAttribute("data-text-size", "large");
    });
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement).toHaveAttribute("data-palette", "moss");
    expect(document.documentElement).toHaveAttribute("data-text-size", "large");
    expect(document.documentElement).toHaveAttribute("lang", "en");

    await user.click(screen.getByRole("button", { name: "应用新偏好" }));

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-theme", "light");
      expect(document.documentElement).toHaveAttribute("data-palette", "plum");
      expect(document.documentElement).toHaveAttribute("data-text-size", "small");
      expect(document.documentElement).toHaveAttribute("lang", "zh-CN");
      expect(window.localStorage.getItem("matchplane.theme")).toBe("light");
      expect(window.localStorage.getItem("matchplane.locale")).toBe("zh");
      expect(window.localStorage.getItem("matchplane.palette")).toBe("plum");
      expect(window.localStorage.getItem("matchplane.text-size")).toBe("small");
    });
  });
});

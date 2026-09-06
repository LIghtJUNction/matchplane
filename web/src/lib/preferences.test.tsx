import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { renderToString } from "react-dom/server";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyInterfaceLocale,
  applyInterfacePalette,
  applyInterfaceTextSize,
  applyInterfaceTheme,
  INTERFACE_PALETTES,
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
  applyInterfacePalette("moss");
  applyInterfaceTextSize("default");
});

describe("interface preference persistence", () => {
  it("server-renders moss without reading saved client preferences", () => {
    window.localStorage.setItem("matchplane.palette", "ink");
    window.localStorage.setItem("matchplane.theme", "dark");
    window.localStorage.setItem("matchplane.locale", "en");

    const markup = renderToString(<PreferencesHarness />);

    expect(markup).toContain('data-palette="moss"');
    expect(markup).toContain('data-theme="light"');
    expect(markup).toContain('data-locale="zh"');
    expect(markup).toContain('data-text-size="default"');
    expect(window.localStorage.getItem("matchplane.palette")).toBe("ink");
  });

  it.each([
    null,
    "",
    "unknown",
    "MOSS",
  ])("defaults a missing or invalid palette (%s) to moss", async (storedPalette) => {
    if (storedPalette !== null) {
      window.localStorage.setItem("matchplane.palette", storedPalette);
    }
    render(<PreferencesHarness />);

    await waitFor(() => {
      expect(screen.getByTestId("preferences")).toHaveAttribute(
        "data-palette",
        "moss",
      );
      expect(document.documentElement).toHaveAttribute("data-palette", "moss");
      expect(window.localStorage.getItem("matchplane.palette")).toBe("moss");
    });
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.documentElement).toHaveAttribute("lang", "zh-CN");
  });

  it.each(
    INTERFACE_PALETTES.map(({ id }) => id),
  )("preserves a saved %s palette with dark mode and English", async (palette) => {
    window.localStorage.setItem("matchplane.palette", palette);
    window.localStorage.setItem("matchplane.theme", "dark");
    window.localStorage.setItem("matchplane.locale", "en");
    window.localStorage.setItem("matchplane.text-size", "large");
    render(<PreferencesHarness />);

    await waitFor(() => {
      expect(screen.getByTestId("preferences")).toHaveAttribute(
        "data-palette",
        palette,
      );
      expect(document.documentElement).toHaveAttribute("data-palette", palette);
      expect(window.localStorage.getItem("matchplane.palette")).toBe(palette);
    });
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.documentElement).toHaveAttribute("lang", "en");
    expect(document.documentElement).toHaveAttribute("data-text-size", "large");
  });

  it("previews moss with the marketplace accent", () => {
    expect(INTERFACE_PALETTES.find(({ id }) => id === "moss")?.swatch).toBe(
      "#16804a",
    );
  });
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
      expect(document.documentElement).toHaveAttribute(
        "data-text-size",
        "small",
      );
      expect(document.documentElement).toHaveAttribute("lang", "zh-CN");
      expect(window.localStorage.getItem("matchplane.theme")).toBe("light");
      expect(window.localStorage.getItem("matchplane.locale")).toBe("zh");
      expect(window.localStorage.getItem("matchplane.palette")).toBe("plum");
      expect(window.localStorage.getItem("matchplane.text-size")).toBe("small");
    });
  });
});

describe("pre-hydration theme initialization", () => {
  // Vitest's DOM transform gives import.meta.url an HTTP URL, not a file URL.
  const themeInit = readFileSync(resolve("public/theme-init.js"), "utf8");

  it("keeps root layout defaults aligned with the server-rendered preferences", () => {
    const layout = readFileSync(resolve("app/layout.tsx"), "utf8");
    const html = layout.match(/<html\b[^>]*>/)?.[0];

    expect(html).toContain('data-palette="moss"');
    expect(html).toContain('data-theme="light"');
    expect(html).toContain('data-text-size="default"');
    expect(html).toContain('lang="zh-CN"');
    expect(layout).toContain(
      '<Script src="/theme-init.js" strategy="beforeInteractive" />',
    );
    expect(layout).not.toContain("DIRECTION_CONTRACT");
  });

  it.each([
    null,
    "",
    "invalid",
    "MOSS",
  ])("applies moss before hydration for a missing or invalid palette (%s)", (storedPalette) => {
    if (storedPalette !== null) {
      window.localStorage.setItem("matchplane.palette", storedPalette);
    }
    applyInterfacePalette("ink");
    runInNewContext(themeInit, { localStorage: window.localStorage, document });

    expect(document.documentElement).toHaveAttribute("data-palette", "moss");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.documentElement).toHaveAttribute("lang", "zh-CN");
    expect(document.documentElement).toHaveAttribute(
      "data-text-size",
      "default",
    );
  });

  it.each(
    INTERFACE_PALETTES.map(({ id }) => id),
  )("restores %s before hydration with dark mode, text size, and English", (palette) => {
    window.localStorage.setItem("matchplane.palette", palette);
    window.localStorage.setItem("matchplane.theme", "dark");
    window.localStorage.setItem("matchplane.locale", "en");
    window.localStorage.setItem("matchplane.text-size", "large");
    runInNewContext(themeInit, { localStorage: window.localStorage, document });

    expect(document.documentElement).toHaveAttribute("data-palette", palette);
    expect(window.localStorage.getItem("matchplane.palette")).toBe(palette);
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(document.documentElement).toHaveAttribute("lang", "en");
    expect(document.documentElement).toHaveAttribute("data-text-size", "large");
  });

  it("keeps the server defaults usable when storage is blocked", () => {
    const localStorage = {
      getItem() {
        throw new Error("Storage blocked");
      },
    };
    applyInterfacePalette("moss");

    expect(() =>
      runInNewContext(themeInit, { localStorage, document }),
    ).not.toThrow();
    expect(document.documentElement).toHaveAttribute("data-palette", "moss");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(document.documentElement).toHaveAttribute("lang", "zh-CN");
  });
});

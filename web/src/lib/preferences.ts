"use client";

import { useEffect, useState } from "react";

export type InterfaceTheme = "light" | "dark";
export type InterfaceLocale = "zh" | "en";
export type InterfacePalette = "ink" | "moss" | "clay" | "amber";

export const INTERFACE_PALETTES: ReadonlyArray<{
  id: InterfacePalette;
  swatch: string;
  label: Record<InterfaceLocale, string>;
}> = [
  { id: "ink", swatch: "#171715", label: { zh: "墨色", en: "Ink" } },
  { id: "moss", swatch: "#315c47", label: { zh: "苔绿", en: "Moss" } },
  { id: "clay", swatch: "#a34a2b", label: { zh: "赤陶", en: "Clay" } },
  { id: "amber", swatch: "#8a5a10", label: { zh: "琥珀", en: "Amber" } },
];

const THEME_KEY = "matchplane.theme";
const LOCALE_KEY = "matchplane.locale";
const PALETTE_KEY = "matchplane.palette";

export function useInterfacePreferences() {
  const [theme, setThemeState] = useState<InterfaceTheme>("light");
  const [locale, setLocaleState] = useState<InterfaceLocale>("zh");
  const [palette, setPaletteState] = useState<InterfacePalette>("ink");
  const [preferencesReady, setPreferencesReady] = useState(false);

  useEffect(() => {
    const storedTheme = window.localStorage.getItem(THEME_KEY);
    const storedLocale = window.localStorage.getItem(LOCALE_KEY);
    const storedPalette = window.localStorage.getItem(PALETTE_KEY);
    const nextTheme = storedTheme === "dark" ? "dark" : "light";
    const nextLocale = storedLocale === "en" ? "en" : "zh";
    const nextPalette =
      storedPalette === "plum" || !isInterfacePalette(storedPalette)
        ? "ink"
        : storedPalette;
    setThemeState(nextTheme);
    setLocaleState(nextLocale);
    setPaletteState(nextPalette);
    applyInterfaceTheme(nextTheme);
    applyInterfaceLocale(nextLocale);
    applyInterfacePalette(nextPalette);
    setPreferencesReady(true);
  }, []);

  useEffect(() => {
    if (!preferencesReady) return;
    applyInterfaceTheme(theme);
    window.localStorage.setItem(THEME_KEY, theme);
  }, [preferencesReady, theme]);

  useEffect(() => {
    if (!preferencesReady) return;
    applyInterfaceLocale(locale);
    window.localStorage.setItem(LOCALE_KEY, locale);
  }, [locale, preferencesReady]);

  useEffect(() => {
    if (!preferencesReady) return;
    applyInterfacePalette(palette);
    window.localStorage.setItem(PALETTE_KEY, palette);
  }, [palette, preferencesReady]);

  return {
    theme,
    locale,
    palette,
    setTheme: (next: InterfaceTheme) => setThemeState(next),
    setLocale: (next: InterfaceLocale) => setLocaleState(next),
    setPalette: (next: InterfacePalette) => setPaletteState(next),
  };
}

export function applyInterfaceTheme(theme: InterfaceTheme): void {
  if (!("document" in globalThis)) return;
  document.documentElement.dataset.theme = theme;
  // Appica scopes its semantic tokens with `.dark`; keep that contract in
  // sync with MatchPlane's persisted data-theme preference.
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

export function applyInterfacePalette(palette: InterfacePalette): void {
  if (!("document" in globalThis)) return;
  document.documentElement.dataset.palette = palette;
}

export function isInterfacePalette(
  value: string | null,
): value is InterfacePalette {
  return INTERFACE_PALETTES.some((palette) => palette.id === value);
}

export function applyInterfaceLocale(locale: InterfaceLocale): void {
  if (!("document" in globalThis)) return;
  document.documentElement.lang = locale === "en" ? "en" : "zh-CN";
}

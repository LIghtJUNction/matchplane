"use client";

import { useEffect, useState } from "react";

export type InterfaceTheme = "light" | "dark";
export type InterfaceLocale = "zh" | "en";

const THEME_KEY = "matchplane.theme";
const LOCALE_KEY = "matchplane.locale";

export function useInterfacePreferences() {
  const [theme, setThemeState] = useState<InterfaceTheme>("light");
  const [locale, setLocaleState] = useState<InterfaceLocale>("zh");
  const [preferencesReady, setPreferencesReady] = useState(false);

  useEffect(() => {
    const storedTheme = window.localStorage.getItem(THEME_KEY);
    const storedLocale = window.localStorage.getItem(LOCALE_KEY);
    const nextTheme = storedTheme === "dark" ? "dark" : "light";
    const nextLocale = storedLocale === "en" ? "en" : "zh";
    setThemeState(nextTheme);
    setLocaleState(nextLocale);
    applyInterfaceTheme(nextTheme);
    applyInterfaceLocale(nextLocale);
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

  return {
    theme,
    locale,
    setTheme: (next: InterfaceTheme) => setThemeState(next),
    setLocale: (next: InterfaceLocale) => setLocaleState(next),
  };
}

export function applyInterfaceTheme(theme: InterfaceTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  // Appica scopes its semantic tokens with `.dark`; keep that contract in
  // sync with MatchPlane's persisted data-theme preference.
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

export function applyInterfaceLocale(locale: InterfaceLocale): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale === "en" ? "en" : "zh-CN";
}

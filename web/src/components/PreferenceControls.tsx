"use client";

import { Moon, Sun } from "lucide-react";

import type { InterfaceLocale, InterfaceTheme } from "../lib/preferences";

interface PreferenceControlsProps {
      theme: InterfaceTheme;
      locale: InterfaceLocale;
      onThemeChange: (theme: InterfaceTheme) => void;
      onLocaleChange: (locale: InterfaceLocale) => void;
}

export function PreferenceControls({
      theme,
      locale,
      onThemeChange,
      onLocaleChange,
}: PreferenceControlsProps) {
      const isZh = locale === "zh";
      return (
            <div
                  className="preference-controls"
                  aria-label={isZh ? "显示与语言" : "Display and language"}
            >
                  <button
                        className="preference-icon"
                        type="button"
                        aria-label={
                              theme === "dark"
                                    ? isZh
                                          ? "切换到亮色"
                                          : "Use light theme"
                                    : isZh
                                      ? "切换到暗色"
                                      : "Use dark theme"
                        }
                        title={
                              theme === "dark"
                                    ? isZh
                                          ? "亮色"
                                          : "Light"
                                    : isZh
                                      ? "暗色"
                                      : "Dark"
                        }
                        onClick={() =>
                              onThemeChange(theme === "dark" ? "light" : "dark")
                        }
                  >
                        {theme === "dark" ? (
                              <Moon size={15} aria-hidden="true" />
                        ) : (
                              <Sun size={15} aria-hidden="true" />
                        )}
                  </button>
                  <button
                        className="preference-language"
                        type="button"
                        aria-label={isZh ? "EN" : "中"}
                        title={isZh ? "English" : "中文"}
                        onClick={() => onLocaleChange(isZh ? "en" : "zh")}
                  >
                        {isZh ? "EN" : "中"}
                  </button>
            </div>
      );
}

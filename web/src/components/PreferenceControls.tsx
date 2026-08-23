"use client";

import { Button } from "@appica/ui-react/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@appica/ui-react/tooltip";
import { Moon, Sun } from "lucide-react";

import type {
  InterfaceLocale,
  InterfacePalette,
  InterfaceTheme,
} from "../lib/preferences";
import { PalettePicker } from "./PalettePicker";

interface PreferenceControlsProps {
  theme: InterfaceTheme;
  locale: InterfaceLocale;
  palette?: InterfacePalette;
  onThemeChange: (theme: InterfaceTheme) => void;
  onLocaleChange: (locale: InterfaceLocale) => void;
  onPaletteChange?: (palette: InterfacePalette) => void;
}

export function PreferenceControls({
  theme,
  locale,
  palette = "ink",
  onThemeChange,
  onLocaleChange,
  onPaletteChange,
}: PreferenceControlsProps) {
  const isZh = locale === "zh";
  const themeAction =
    theme === "dark"
      ? isZh
        ? "切换到亮色"
        : "Use light theme"
      : isZh
        ? "切换到暗色"
        : "Use dark theme";
  const languageName = isZh ? "English" : "中文";

  return (
    <TooltipProvider delay={350}>
      <div
        className="preference-controls"
        role="group"
        aria-label={isZh ? "显示与语言" : "Display and language"}
      >
        {onPaletteChange ? (
          <PalettePicker
            palette={palette}
            locale={locale}
            onPaletteChange={onPaletteChange}
          />
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                className="preference-icon"
                variant="ghost"
                size="icon-sm"
                type="button"
                aria-label={themeAction}
                onClick={() =>
                  onThemeChange(theme === "dark" ? "light" : "dark")
                }
              >
                {theme === "dark" ? (
                  <Moon size={15} aria-hidden="true" />
                ) : (
                  <Sun size={15} aria-hidden="true" />
                )}
              </Button>
            }
          />
          <TooltipContent side="bottom" arrow={false}>
            {themeAction}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                className="preference-language"
                variant="ghost"
                size="sm"
                type="button"
                aria-label={isZh ? "EN" : "中"}
                onClick={() => onLocaleChange(isZh ? "en" : "zh")}
              >
                {isZh ? "EN" : "中"}
              </Button>
            }
          />
          <TooltipContent side="bottom" arrow={false}>
            {languageName}
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}

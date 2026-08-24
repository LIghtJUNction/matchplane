"use client";

import { Button } from "@appica/ui-react/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@appica/ui-react/popover";
import { Languages, Moon, Settings2, Sun } from "lucide-react";

import type {
  InterfaceLocale,
  InterfacePalette,
  InterfaceTextSize,
  InterfaceTheme,
} from "../lib/preferences";
import { PalettePicker } from "./PalettePicker";

interface PreferenceControlsProps {
  theme: InterfaceTheme;
  locale: InterfaceLocale;
  palette?: InterfacePalette;
  textSize?: InterfaceTextSize;
  mode?: "popover" | "panel";
  onThemeChange: (theme: InterfaceTheme) => void;
  onLocaleChange: (locale: InterfaceLocale) => void;
  onPaletteChange?: (palette: InterfacePalette) => void;
  onTextSizeChange?: (textSize: InterfaceTextSize) => void;
}

export function PreferenceControls({
  theme,
  locale,
  palette = "ink",
  textSize = "default",
  mode = "popover",
  onThemeChange,
  onLocaleChange,
  onPaletteChange,
  onTextSizeChange,
}: PreferenceControlsProps) {
  const isZh = locale === "zh";
  const controls = (
    <div className="preference-panel">
      {onPaletteChange ? (
        <PalettePicker
          palette={palette}
          locale={locale}
          onPaletteChange={onPaletteChange}
        />
      ) : null}

      <div className="preference-setting">
        <span className="preference-setting-label">
          {isZh ? "明暗主题" : "Color mode"}
        </span>
        <div
          className="preference-segmented"
          role="group"
          aria-label={isZh ? "明暗主题" : "Color mode"}
        >
          <button
            type="button"
            aria-pressed={theme === "light"}
            onClick={() => onThemeChange("light")}
          >
            <Sun size={16} aria-hidden="true" />
            <span>{isZh ? "浅色" : "Light"}</span>
          </button>
          <button
            type="button"
            aria-pressed={theme === "dark"}
            onClick={() => onThemeChange("dark")}
          >
            <Moon size={16} aria-hidden="true" />
            <span>{isZh ? "深色" : "Dark"}</span>
          </button>
        </div>
      </div>

      {onTextSizeChange ? (
        <div className="preference-setting">
          <span className="preference-setting-label">
            {isZh ? "文字大小" : "Text size"}
          </span>
          <div
            className="preference-segmented preference-text-size"
            role="group"
            aria-label={isZh ? "文字大小" : "Text size"}
          >
            <button
              type="button"
              aria-label={isZh ? "较小文字" : "Smaller text"}
              aria-pressed={textSize === "small"}
              onClick={() => onTextSizeChange("small")}
            >
              A−
            </button>
            <button
              type="button"
              aria-label={isZh ? "默认文字大小" : "Default text size"}
              aria-pressed={textSize === "default"}
              onClick={() => onTextSizeChange("default")}
            >
              A
            </button>
            <button
              type="button"
              aria-label={isZh ? "较大文字" : "Larger text"}
              aria-pressed={textSize === "large"}
              onClick={() => onTextSizeChange("large")}
            >
              A+
            </button>
          </div>
        </div>
      ) : null}

      <div className="preference-setting">
        <span className="preference-setting-label">
          {isZh ? "界面语言" : "Language"}
        </span>
        <div
          className="preference-segmented"
          role="group"
          aria-label={isZh ? "界面语言" : "Language"}
        >
          <button
            type="button"
            aria-pressed={locale === "zh"}
            onClick={() => onLocaleChange("zh")}
          >
            <Languages size={16} aria-hidden="true" />
            <span>中文</span>
          </button>
          <button
            type="button"
            aria-pressed={locale === "en"}
            onClick={() => onLocaleChange("en")}
          >
            <Languages size={16} aria-hidden="true" />
            <span>English</span>
          </button>
        </div>
      </div>
    </div>
  );

  if (mode === "panel") {
    return <div className="preference-controls is-panel">{controls}</div>;
  }

  const triggerLabel = isZh ? "显示与语言" : "Display and language";
  return (
    <div className="preference-controls">
      <Popover>
        <PopoverTrigger
          render={
            <Button
              className="preference-trigger"
              size="icon-md"
              variant="ghost"
              aria-label={triggerLabel}
            />
          }
        >
          <Settings2 size={18} aria-hidden="true" />
          <span
            className="preference-trigger-preview"
            data-palette-preview={palette}
            aria-hidden="true"
          >
            <i />
            <i />
            <i />
          </span>
        </PopoverTrigger>
        <PopoverContent
          className="preference-popover"
          side="bottom"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          positionMethod="fixed"
          positionerProps={{ className: "preference-popover-positioner" }}
        >
          <PopoverTitle>{triggerLabel}</PopoverTitle>
          <PopoverDescription>
            {isZh
              ? "调整配色、明暗、文字大小和语言。"
              : "Adjust palette, color mode, text size, and language."}
          </PopoverDescription>
          {controls}
        </PopoverContent>
      </Popover>
    </div>
  );
}

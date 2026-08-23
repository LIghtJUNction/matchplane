"use client";

import { Button } from "@appica/ui-react/button";
import { formatColor, type Color } from "@appica/ui-react/color";
import {
  ColorSwatchPicker,
  ColorSwatchPickerItem,
} from "@appica/ui-react/color-swatch-picker";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@appica/ui-react/popover";
import { Palette } from "lucide-react";

import {
  INTERFACE_PALETTES,
  type InterfaceLocale,
  type InterfacePalette,
} from "../lib/preferences";

interface PalettePickerProps {
  palette: InterfacePalette;
  locale: InterfaceLocale;
  onPaletteChange: (palette: InterfacePalette) => void;
}

export function PalettePicker({
  palette,
  locale,
  onPaletteChange,
}: PalettePickerProps) {
  const selected =
    INTERFACE_PALETTES.find((option) => option.id === palette) ??
    INTERFACE_PALETTES[0];
  const isZh = locale === "zh";

  const chooseColor = (color: Color) => {
    const value = formatColor(color, "hex").slice(0, 7).toLowerCase();
    const next = INTERFACE_PALETTES.find(
      (option) => option.swatch.toLowerCase() === value,
    );
    if (next) onPaletteChange(next.id);
  };

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            className="preference-icon preference-palette-trigger"
            variant="ghost"
            size="icon-sm"
            type="button"
            aria-label={
              isZh
                ? `选择配色：${selected.label.zh}`
                : `Choose palette: ${selected.label.en}`
            }
            title={isZh ? "配色" : "Palette"}
          >
            <Palette size={15} aria-hidden="true" />
            <span
              className="preference-palette-indicator"
              style={{ background: selected.swatch }}
              aria-hidden="true"
            />
          </Button>
        }
      />
      <PopoverContent
        className="palette-popover"
        side="bottom"
        align="end"
        sideOffset={10}
        arrow={false}
      >
        <PopoverTitle className="palette-popover-title">
          {isZh ? "选择配色" : "Choose a palette"}
        </PopoverTitle>
        <PopoverDescription className="palette-popover-description">
          {isZh
            ? "墨色是默认方案；选择会保存在这台设备上。"
            : "Ink is the default. Your choice stays on this device."}
        </PopoverDescription>
        <ColorSwatchPicker
          className="palette-swatch-picker"
          value={selected.swatch}
          onValueChange={chooseColor}
          layout="grid"
          shape="circle"
          size={44}
          aria-label={isZh ? "配色方案" : "Color palettes"}
        >
          {INTERFACE_PALETTES.map((option) => (
            <ColorSwatchPickerItem
              color={option.swatch}
              colorName={option.label[locale]}
              key={option.id}
            />
          ))}
        </ColorSwatchPicker>
        <div className="palette-popover-options" aria-hidden="true">
          {INTERFACE_PALETTES.map((option) => (
            <span
              className={option.id === palette ? "is-selected" : undefined}
              key={option.id}
            >
              {option.label[locale]}
            </span>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

"use client";

import { Button } from "@appica/ui-react/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@appica/ui-react/popover";
import { Radio } from "@appica/ui-react/radio";
import { RadioGroup } from "@appica/ui-react/radio-group";
import { Check, Palette } from "lucide-react";

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

const PALETTE_PREVIEWS: Record<InterfacePalette, readonly string[]> = {
  ink: ["#f2efe7", "#fffdf8", "#171715", "#72736d"],
  moss: ["#e5ede7", "#fbfcf9", "#315c47", "#203329"],
  clay: ["#f2e2da", "#fffaf6", "#a34a2b", "#43251b"],
  plum: ["#ece2ea", "#fcf9fc", "#6f506b", "#342832"],
  amber: ["#f0e6d5", "#fffaf2", "#8a5a10", "#382b16"],
};

export function PalettePicker({
  palette,
  locale,
  onPaletteChange,
}: PalettePickerProps) {
  const selected =
    INTERFACE_PALETTES.find((option) => option.id === palette) ??
    INTERFACE_PALETTES[0];
  const isZh = locale === "zh";

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
            ? "预览背景、表面、强调色和文字；选择会保存在这台设备上。"
            : "Preview background, surface, accent, and text. Your choice stays on this device."}
        </PopoverDescription>
        <RadioGroup
          className="palette-radio-group"
          value={palette}
          onValueChange={(value) => onPaletteChange(value as InterfacePalette)}
          aria-label={isZh ? "配色方案" : "Color palettes"}
        >
          {INTERFACE_PALETTES.map((option) => (
            <label className="palette-radio-card" key={option.id}>
              <span className="palette-radio-preview" aria-hidden="true">
                {PALETTE_PREVIEWS[option.id].map((color) => (
                  <span key={color} style={{ backgroundColor: color }} />
                ))}
              </span>
              <span className="palette-radio-label">
                <span>{option.label[locale]}</span>
                {option.id === palette ? (
                  <Check size={14} aria-hidden="true" />
                ) : null}
              </span>
              <Radio
                className="palette-radio-control"
                value={option.id}
              />
            </label>
          ))}
        </RadioGroup>
      </PopoverContent>
    </Popover>
  );
}

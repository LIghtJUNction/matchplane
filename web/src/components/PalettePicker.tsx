"use client";

import { useId } from "react";
import { Check } from "lucide-react";

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

/** A compact, real-role preview of the marketplace color palettes. */
export function PalettePicker({
  palette,
  locale,
  onPaletteChange,
}: PalettePickerProps) {
  const groupName = useId();
  const isZh = locale === "zh";

  return (
    <fieldset className="palette-picker">
      <legend>{isZh ? "界面配色" : "Interface palette"}</legend>
      <div className="palette-options">
        {INTERFACE_PALETTES.map((option) => {
          const selected = option.id === palette;
          const label = option.label[locale];
          return (
            <label
              className="palette-option"
              data-palette-preview={option.id}
              key={option.id}
            >
              <input
                type="radio"
                name={groupName}
                value={option.id}
                checked={selected}
                onChange={() => onPaletteChange(option.id)}
                aria-label={
                  selected
                    ? `${label}${isZh ? "，当前配色" : ", current palette"}`
                    : label
                }
              />
              <span className="palette-option-preview" aria-hidden="true">
                <span className="palette-preview-surface" />
                <span className="palette-preview-background" />
                <span className="palette-preview-accent" />
                <span className="palette-preview-text">
                  <i />
                  <i />
                </span>
              </span>
              <span className="palette-option-name">{label}</span>
              <Check
                className="palette-option-check"
                size={15}
                strokeWidth={2}
                aria-hidden="true"
              />
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

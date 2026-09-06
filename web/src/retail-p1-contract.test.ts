import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = existsSync(join(process.cwd(), "src", "styles.css"))
  ? join(process.cwd(), "src") : join(process.cwd(), "web", "src");
const sourcePath = (file: string) => join(sourceRoot, file);
const legacyCss = readFileSync(sourcePath("styles.css"), "utf8");
const retailCss = readFileSync(sourcePath("retail-ui.css"), "utf8");
const polishCss = readFileSync(sourcePath("retail-polish.css"), "utf8");
const rootMarketplaceCss = readFileSync(sourcePath("root-marketplace.css"), "utf8");
const marketplaceHome = readFileSync(sourcePath("components/MarketplaceHome.tsx"), "utf8");
const rootLayout = readFileSync(join(sourceRoot, "..", "app", "layout.tsx"), "utf8");

function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = css.replace(/\s+/g, " ").match(new RegExp(`${escaped}\\s*(?:,[^{]+)?\\{([^}]+)\\}`))?.[1];
  if (!body) throw new Error(`Missing style rule: ${selector}`);
  return body;
}

function color(css: string, name: string): string {
  const value = css.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6});`, "i"))?.[1];
  if (!value) throw new Error(`Missing color: ${name}`);
  return value;
}

function contrast(foreground: string, background: string): number {
  const luminance = (hex: string) => [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

describe("public marketplace accessibility and layout contract", () => {
  it("keeps desktop login geometry independent of theme", () => {
    expect(legacyCss).not.toMatch(/\.login-layout,\s*:root\[data-theme=["']dark["']\]\s+\.login-layout\s*{/);
    expect(retailCss).toMatch(/\.login-layout\s*{[^}]*grid-template-columns:\s*minmax\([^)]+\)\s+minmax\([^)]+\);/s);
  });

  it("keeps actual muted text colors above the normal-text contrast floor", () => {
    // Guard readability, not the hex values of the retired warm-paper palette.
    for (const theme of [rule(retailCss, ":root"), rule(retailCss, ':root[data-theme="dark"]')]) {
      for (const surface of ["--retail-canvas", "--retail-surface", "--retail-surface-soft"]) {
        expect(contrast(color(theme, "--retail-muted"), color(theme, surface))).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("retains explicit focus rings and coarse-pointer target sizing", () => {
    expect(rootMarketplaceCss.replace(/\s+/g, " ")).toMatch(
      /\.match-chat-starter-card:focus-visible,[^{]+\.home-chat-form:focus-within\s*\{[^}]*outline:\s*3px solid var\(--retail-focus\);/,
    );
    expect(polishCss).toMatch(/\.match-chat-form:focus-within,[^{]+\{[^}]*outline:\s*3px solid var\(--retail-focus\) !important;/s);
    expect(polishCss).toMatch(/@media \(pointer: coarse\)[\s\S]*\.match-chat-more-trigger,[\s\S]*\.login-password-visibility[\s\S]*min-width:\s*44px !important;[\s\S]*min-height:\s*44px !important;/);
    expect(polishCss).toMatch(/\.login-back,[\s\S]*\.login-registration-link a,[\s\S]*\.login-link-button[\s\S]*min-height:\s*44px;/);
    expect(rule(rootMarketplaceCss, ".match-chat-starter-card")).toContain("min-height: 2.75rem;");
  });

  it("keeps registration consent square, keyboard-visible, and touch-sized", () => {
    expect(polishCss).toMatch(/\.login-card \.login-form \.login-legal-checkbox input\[type="checkbox"\]\s*\{[^}]*width:\s*1\.25rem;[^}]*min-width:\s*1\.25rem;[^}]*height:\s*1\.25rem;[^}]*min-height:\s*1\.25rem;[^}]*padding:\s*0;/s);
    expect(polishCss).toMatch(/\.login-card[\s\S]*?\.login-legal-checkbox[\s\S]*?input\[type="checkbox"\]:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--retail-focus\);[^}]*outline-offset:\s*3px;/s);
    expect(legacyCss).toMatch(/\.login-form label\.login-legal-checkbox\s*\{[^}]*width:\s*2\.75rem;[^}]*min-height:\s*2\.75rem;/s);
    expect(polishCss).toMatch(/\.login-legal-copy\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*break-word;/s);
  });

  it("lets store settings shrink without weakening mobile scroll", () => {
    expect(polishCss).toMatch(/\.workspace-settings-dialog\.workspace-settings-dialog-stores\s*\{[^}]*height:\s*auto;[^}]*min-height:\s*0;[^}]*max-height:\s*calc\(100dvh - 2rem\);/s);
    expect(polishCss).toMatch(/\.workspace-settings-dialog-stores \.hosted-store-empty-state\s*\{[^}]*min-height:\s*0;[^}]*border-color:\s*color-mix\([^}]*var\(--retail-ink\) 36%[^}]*background:\s*color-mix\(/s);
    expect(polishCss).toMatch(/\.workspace-settings-dialog-stores \.hosted-store-empty-state p\s*\{[^}]*color:\s*var\(--retail-ink-soft\);/s);
    expect(polishCss).toMatch(/@media \(max-width: 48rem\)[\s\S]*?\.workspace-settings-dialog\.workspace-settings-dialog-stores\s*\{[^}]*height:\s*100dvh;[^}]*max-height:\s*100dvh;[\s\S]*?\.workspace-settings-layout\s*\{[^}]*grid-template-columns:\s*1fr;/s);
    expect(polishCss).toMatch(/@media \(max-width: 48rem\)[\s\S]*?\.workspace-settings-dialog-stores \.workspace-settings-navigation button\s*\{[^}]*min-height:\s*2\.75rem;/s);
    expect(legacyCss).toMatch(/\.workspace-settings-close\s*\{[^}]*min-width:\s*2\.75rem;[^}]*height:\s*2\.75rem;/s);
  });

  it("loads one bounded root stylesheet after general polish", () => {
    expect(rootLayout).toMatch(/import "\.\.\/src\/retail-polish\.css";\s*import "\.\.\/src\/root-marketplace\.css";/);
    expect(polishCss).not.toContain(".root-marketplace");
    // A byte budget remains meaningful when the formatter wraps selectors.
    expect(Buffer.byteLength(rootMarketplaceCss)).toBeLessThan(24_000);
    expect(polishCss.split("\n").length).toBeLessThan(500);
  });

  it("keeps a compact entry and a responsive product-first catalog", () => {
    expect(marketplaceHome).not.toContain("sparseCatalog");
    expect(marketplaceHome).not.toContain("is-sparse");
    expect(retailCss).not.toContain(".root-marketplace-content.is-sparse");
    expect(rule(rootMarketplaceCss, ".root-marketplace-entry")).toContain("min-height: 0;");
    expect(rule(rootMarketplaceCss, ".root-marketplace-entry-frame")).toContain("grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.4fr);");
    expect(rule(rootMarketplaceCss, ".home-chat")).toContain("box-shadow: none;");
    expect(rule(rootMarketplaceCss, ".home-chat-form")).toContain("background: var(--retail-surface);");
    expect(rule(rootMarketplaceCss, ".match-chat-starter-grid")).toContain("flex-wrap: wrap;");
    expect(rule(rootMarketplaceCss, ".root-marketplace-products-grid")).toContain("repeat(4, minmax(0, 1fr))");
    const mobile = rootMarketplaceCss.slice(rootMarketplaceCss.indexOf("@media (max-width: 760px)"));
    expect(rule(mobile, ".root-marketplace-entry-frame")).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(rule(mobile, ".root-marketplace-products-grid")).toContain("repeat(2, minmax(0, 1fr))");
    expect(rule(mobile, ".root-marketplace-inline-categories")).toContain("overflow-x: auto;");
    expect(rootMarketplaceCss).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("retains readable metadata and expands active conversations on one axis", () => {
    expect(rule(rootMarketplaceCss, ".root-marketplace-privacy")).toContain("color: var(--retail-muted);");
    expect(rule(rootMarketplaceCss, ".root-marketplace-scroll-cue")).toContain("min-height: 2.75rem;");
    expect(rule(rootMarketplaceCss, ".root-marketplace-products-heading span")).toContain("color: var(--retail-muted);");
    expect(rule(rootMarketplaceCss, ".root-marketplace-entry:has(.home-chat.has-conversation) .root-marketplace-entry-frame"))
      .toContain("grid-template-columns: minmax(0, 1fr);");
    expect(rule(rootMarketplaceCss, ".root-marketplace-entry:has(.home-chat.has-conversation) .root-marketplace-scroll-cue"))
      .toContain("display: none;");
  });
});

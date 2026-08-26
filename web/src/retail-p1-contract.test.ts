import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = existsSync(join(process.cwd(), "src", "styles.css"))
  ? join(process.cwd(), "src")
  : join(process.cwd(), "web", "src");
const sourcePath = (file: string) => join(sourceRoot, file);
const legacyCss = readFileSync(sourcePath("styles.css"), "utf8");
const retailCss = readFileSync(sourcePath("retail-ui.css"), "utf8");
const polishCss = readFileSync(sourcePath("retail-polish.css"), "utf8");
const rootMarketplaceCss = readFileSync(
  sourcePath("root-marketplace.css"),
  "utf8",
);
const marketplaceHome = readFileSync(
  sourcePath("components/MarketplaceHome.tsx"),
  "utf8",
);
const rootLayout = readFileSync(
  join(sourceRoot, "..", "app", "layout.tsx"),
  "utf8",
);

describe("public retail P1 style contract", () => {
  it("keeps desktop login geometry independent of theme", () => {
    expect(legacyCss).not.toMatch(
      /\.login-layout,\s*:root\[data-theme=["']dark["']\]\s+\.login-layout\s*{/,
    );
    expect(retailCss).toMatch(
      /\.login-layout\s*{[^}]*grid-template-columns:\s*minmax\([^)]+\)\s+minmax\([^)]+\);/s,
    );
  });

  it("keeps the light muted token above the audited contrast floor", () => {
    expect(retailCss).toMatch(/--retail-muted:\s*#6c6962;/);
    expect(retailCss).toMatch(
      /:root\[data-theme="dark"\][^{]*{[^}]*--retail-muted:\s*#aaa49a;/s,
    );
  });

  it("retains explicit focus rings and coarse-pointer target sizing", () => {
    expect(rootMarketplaceCss).toMatch(
      /\.match-chat-starter-card:focus-visible,[^{]+\.home-chat-form:focus-within\s*\{[^}]*outline:\s*3px solid var\(--retail-focus\) !important;/s,
    );
    expect(polishCss).toMatch(
      /\.match-chat-form:focus-within,[^{]+\{[^}]*outline:\s*3px solid var\(--retail-focus\) !important;/s,
    );
    expect(polishCss).toMatch(
      /@media \(pointer: coarse\)[\s\S]*\.match-chat-more-trigger,[\s\S]*\.login-password-visibility[\s\S]*min-width:\s*44px !important;[\s\S]*min-height:\s*44px !important;/,
    );
    expect(polishCss).toMatch(
      /\.login-back,[\s\S]*\.login-registration-link a,[\s\S]*\.login-link-button[\s\S]*min-height:\s*44px;/,
    );
  });

  it("loads one readable root-marketplace authority after general polish", () => {
    expect(rootLayout).toMatch(
      /import "\.\.\/src\/retail-polish\.css";\s*import "\.\.\/src\/root-marketplace\.css";/,
    );
    expect(polishCss).not.toContain(".root-marketplace");
    expect(rootMarketplaceCss.split("\n").length).toBeLessThan(500);
    expect(polishCss.split("\n").length).toBeLessThan(500);
  });

  it("locks the root entrance and inventory to one compact axis", () => {
    expect(marketplaceHome).not.toContain("sparseCatalog");
    expect(marketplaceHome).not.toContain("is-sparse");
    expect(retailCss).not.toContain(".root-marketplace-content.is-sparse");
    expect(rootMarketplaceCss).not.toMatch(
      /\.root-marketplace-entry[^{}]*\{[^}]*grid-template-columns:/s,
    );
    expect(rootMarketplaceCss).toMatch(
      /\.root-marketplace-entry\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/s,
    );
    expect(rootMarketplaceCss).toMatch(
      /\.root-marketplace-concierge \.home-chat,[\s\S]*?border:\s*0;[\s\S]*?box-shadow:\s*none;/,
    );
    expect(rootMarketplaceCss).toMatch(
      /\.root-marketplace-concierge \.home-chat-form\s*\{[^}]*background:\s*var\(--retail-surface-raised\);[^}]*box-shadow:\s*var\(--shadow-small\);/s,
    );
    expect(rootMarketplaceCss).toMatch(
      /\.match-chat-starter-grid\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*justify-content:\s*center;/s,
    );
    expect(rootMarketplaceCss).not.toMatch(
      /\.match-chat-starter-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,/s,
    );
    expect(rootMarketplaceCss).toMatch(
      /\.match-chat-starter-card\s*\{[^}]*max-width:\s*100%;[^}]*min-height:\s*44px;/s,
    );
    expect(rootMarketplaceCss).toMatch(
      /\.match-chat-starter-card-top\s*\{[^}]*display:\s*none;/s,
    );
    expect(rootMarketplaceCss).not.toMatch(
      /\.match-chat-starter-card-top\s*\{[^}]*display:\s*contents;/s,
    );
    expect(rootMarketplaceCss).toMatch(
      /\.root-marketplace-content\s*\{[^}]*display:\s*block;/s,
    );
    expect(rootMarketplaceCss).toMatch(
      /\.root-marketplace-empty\s*\{[^}]*min-height:\s*0;[^}]*border-radius:\s*0;/s,
    );
    expect(rootMarketplaceCss).toMatch(
      /\.storefront-directory-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\([\s\S]*?auto-fit,[\s\S]*?minmax\(min\(100%, 22rem\), calc\(32rem - 0\.375rem\)\)[\s\S]*?justify-content:\s*start;/,
    );
    expect(rootMarketplaceCss).toMatch(
      /\.storefront-directory-card\s*\{[^}]*max-width:\s*32rem;/s,
    );
  });

  it("keeps root metadata readable and condenses active content on one axis", () => {
    expect(rootMarketplaceCss).toMatch(
      /\.root-marketplace-catalog-intro > p\s*\{[^}]*color:\s*var\(--retail-ink-soft\);[^}]*font-size:\s*0\.76rem;/s,
    );
    expect(rootMarketplaceCss).toMatch(
      /\.root-marketplace-entry-facts\s*\{[^}]*color:\s*var\(--retail-ink-soft\);[^}]*font-size:\s*0\.76rem;/s,
    );
    expect(rootMarketplaceCss).toMatch(
      /\.root-marketplace-products-heading p\s*\{[^}]*color:\s*var\(--retail-ink-soft\);[^}]*font-size:\s*0\.76rem;/s,
    );
    expect(rootMarketplaceCss).toMatch(
      /\.root-marketplace-scroll-cue\s*\{[^}]*color:\s*var\(--retail-ink-soft\);[^}]*font-size:\s*0\.76rem;/s,
    );
    expect(rootMarketplaceCss).toMatch(
      /\.root-marketplace-entry\.has-results,\s*\.root-marketplace-entry:has\(\.home-chat\.has-conversation\)\s*\{[^}]*flex-direction:\s*column;[^}]*gap:\s*0\.5rem;/s,
    );
    expect(rootMarketplaceCss).not.toMatch(
      /\.root-marketplace-entry\.has-results,\s*\.root-marketplace-entry:has\(\.home-chat\.has-conversation\)\s*\{[^}]*grid-template-columns:/s,
    );
    expect(rootMarketplaceCss).toMatch(
      /\.root-marketplace-entry\.has-results \.root-marketplace-catalog-intro > span,[\s\S]*?\.root-marketplace-entry:has\(\.home-chat\.has-conversation\)[\s\S]*?\.root-marketplace-entry-facts\s*\{[^}]*display:\s*none;/,
    );
  });
});

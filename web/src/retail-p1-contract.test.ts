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
    expect(polishCss).toMatch(
      /\.match-chat-starter-card:focus-visible,[\s\S]*\.match-chat-form:focus-within[\s\S]*outline:\s*3px solid var\(--retail-focus\) !important;/,
    );
    expect(polishCss).toMatch(
      /@media \(pointer: coarse\)[\s\S]*\.match-chat-more-trigger,[\s\S]*\.login-password-visibility[\s\S]*min-width:\s*44px !important;[\s\S]*min-height:\s*44px !important;/,
    );
    expect(polishCss).toMatch(
      /\.login-back,[\s\S]*\.login-registration-link a,[\s\S]*\.login-link-button[\s\S]*min-height:\s*44px;/,
    );
  });
});

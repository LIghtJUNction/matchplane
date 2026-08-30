import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = join(process.cwd(), "src");
const readSource = (file: string) =>
  readFileSync(join(sourceRoot, file), "utf8");

describe("admin control target contract", () => {
  it("keeps finance record views primary and at least 44px", () => {
    const source = readSource("components/PlatformFinanceRecordsPanel.tsx");
    expect(source).toMatch(
      /className="min-h-11"\s+size="md"\s+type="button"\s+variant=\{view === "invoices" \? "primary" : "ghost"\}/,
    );
    expect(source).toMatch(
      /className="min-h-11"\s+size="md"\s+type="button"\s+variant=\{view === "refunds" \? "primary" : "ghost"\}/,
    );
    expect(source).not.toMatch(/finance-record-tabs[\s\S]*?sm:min-h-9/);
  });

  it("passes optional SectionHeading action classes through Primitives", () => {
    const source = readSource("components/Primitives.tsx");
    expect(source).toContain("actionClassName?: string;");
    expect(source).toContain(
      'className={`text-action${actionClassName ? ` ${actionClassName}` : ""}`}',
    );
  });

  it("keeps account primary and icon actions on 44px targets", () => {
    const password = readSource("components/ChangePasswordPanel.tsx");
    expect(password).toMatch(
      /<Button\s+className="min-h-11"\s+size="md"\s+type="submit"/,
    );

    const identities = readSource("components/IdentityBindingsPanel.tsx");
    expect(identities.match(/<Button\b/g)).toHaveLength(7);
    expect(identities.match(/className="min-h-11"/g)).toHaveLength(7);
    expect(identities.match(/size="md"/g)).toHaveLength(7);

    const passkeys = readSource("components/PasskeyPanel.tsx");
    expect(passkeys).toMatch(/className="min-h-11"\s+size="md"/);
    expect(passkeys).toMatch(
      /className="min-h-11 min-w-11"[\s\S]*?size="icon-sm"/,
    );

    const sessions = readSource("components/SessionPanel.tsx");
    expect(sessions.match(/className="min-h-11" size="md"/g)).toHaveLength(2);
    expect(sessions).toMatch(
      /className="min-h-11 min-w-11"[\s\S]*?size="icon-sm"/,
    );
  });

  it("sizes interactive CSS targets without enlarging footer labels", () => {
    const css = readSource("styles.css");
    expect(css).toMatch(/\.brand \{[^}]*min-height: 2\.75rem;/);
    expect(css).toMatch(/\.app-footer a \{ min-height: 2\.75rem; \}/);
    expect(css).not.toMatch(
      /\.app-footer > span[^,{]*\{[^}]*min-height:\s*(?:2\.75rem|44px)/,
    );
    expect(css).toMatch(
      /\.subplatform-back-link \{ width: 2\.75rem; height: 2\.75rem;/,
    );
    expect(css).toMatch(/\.platform-back-link \{[^}]*min-height: 2\.75rem;/);
    expect(css).toMatch(
      /\.mall-brand-fields input:not\(\[type="file"\]\) \{[^}]*min-height: 2\.75rem;/,
    );
    expect(css).toMatch(
      /\.mall-brand-upload \.button \{ min-height: 2\.75rem;/,
    );
    expect(css).toMatch(
      /\.mall-brand-legal-heading a \{ min-width: 2\.75rem; min-height: 2\.75rem;/,
    );
    expect(css).toMatch(/\.workspace-account-action \{ min-height: 2\.75rem;/);
    expect(css).toMatch(/\.password-settings-revoke \{ min-height: 44px;/);
    expect(css).toMatch(/\.password-settings-actions > a \{ min-height: 44px;/);
  });
});

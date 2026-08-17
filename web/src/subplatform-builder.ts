import { createHash, timingSafeEqual } from "node:crypto";

import { loadInternalBearer } from "./lib/internal-auth";

/**
 * Builder callbacks are machine-to-machine operations, not Better Auth
 * sessions. Compare fixed-size digests so a missing/short token never creates
 * a timing oracle and no raw credential is logged or persisted.
 */
export function hasValidSubplatformBuilderToken(expected: string | undefined, provided: string | null): boolean {
  if (!expected?.trim() || !provided?.trim()) return false;
  const expectedDigest = createHash("sha256").update(expected.trim()).digest();
  const providedDigest = createHash("sha256").update(provided.trim()).digest();
  return timingSafeEqual(expectedDigest, providedDigest);
}

/**
 * Resolve the builder callback secret from the deployment environment or its secret-manager file.
 * The file path is deployment-owned (never request-controlled), and the raw value is kept inside
 * this server-only boundary so route handlers only receive the boolean comparison result.
 */
export async function hasValidConfiguredSubplatformBuilderToken(provided: string | null): Promise<boolean> {
  let expected: string;
  try {
    expected = await loadInternalBearer(
      "MATCHPLANE_SUBPLATFORM_BUILDER_TOKEN",
      "MATCHPLANE_SUBPLATFORM_BUILDER_TOKEN_FILE",
    );
  } catch {
    return false;
  }
  return hasValidSubplatformBuilderToken(expected, provided);
}

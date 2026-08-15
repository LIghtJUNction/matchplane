import { createHash, timingSafeEqual } from "node:crypto";

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

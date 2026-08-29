import { createHash, timingSafeEqual } from "node:crypto";

export const SUPER_ADMIN_BOOTSTRAP_COOKIE =
  "matchplane_super_admin_bootstrap_claim";
export const SUPER_ADMIN_BOOTSTRAP_COOKIE_TTL_SECONDS = 10 * 60;

export interface ReservedSuperAdminInvite {
  registrationEmail: string | null;
  targetEmail: string | null;
  tokenHash: string;
}

/** Hash a bootstrap bearer token before binding it to the claiming browser. */
export function superAdminBootstrapDigest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Read one unambiguous HttpOnly bootstrap token from an incoming Better Auth request. */
export function readSuperAdminBootstrapClaimToken(
  headers: Headers | null | undefined,
): string | null {
  const cookie = headers?.get("cookie");
  if (!cookie) return null;
  let claim: string | null = null;
  for (const part of cookie.split(";")) {
    const [name, value] = part.trim().split("=", 2);
    if (name !== SUPER_ADMIN_BOOTSTRAP_COOKIE) continue;
    if (claim !== null) return null;
    claim = value ?? "";
  }
  return claim && /^mpsa_[0-9a-f]{64}$/.test(claim) ? claim : null;
}

/** Identify an email held aside by either a targeted or already-claimed bootstrap invite. */
export function isReservedSuperAdminEmail(
  invite: ReservedSuperAdminInvite | undefined,
  email: string,
): boolean {
  const normalizedEmail = email.toLowerCase();
  return Boolean(
    invite &&
      ((invite.registrationEmail?.toLowerCase() === normalizedEmail &&
        (!invite.targetEmail ||
          invite.targetEmail.toLowerCase() === normalizedEmail)) ||
        (!invite.registrationEmail &&
          invite.targetEmail?.toLowerCase() === normalizedEmail)),
  );
}

/** Require both the reserved email and the original browser-bound bearer before promotion. */
export function matchesReservedSuperAdminInvite(
  invite: ReservedSuperAdminInvite | undefined,
  email: string,
  claimToken: string | null,
): boolean {
  if (
    !invite?.registrationEmail ||
    !claimToken ||
    !/^mpsa_[0-9a-f]{64}$/.test(claimToken) ||
    !/^[0-9a-f]{64}$/.test(invite.tokenHash)
  )
    return false;
  const expected = Buffer.from(invite.tokenHash, "hex");
  const claimed = Buffer.from(superAdminBootstrapDigest(claimToken), "hex");
  return (
    expected.length === claimed.length &&
    timingSafeEqual(expected, claimed) &&
    isReservedSuperAdminEmail(invite, email)
  );
}

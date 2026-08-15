"use client";

import {
  establishMarketplaceSession,
  isLiveMarketplaceEnabled,
  readPartySession,
  type BetterAuthMarketplaceRole,
  type PartySession,
} from "../api";
import { authClient, authFetchOptions } from "./auth-client";

/**
 * Better Auth is the only user-authentication check. The returned PartySession is a short-lived
 * domain capability for Rust APIs, never a replacement login credential.
 */
export async function getMarketplaceSession(input: {
  subplatform: string;
  tenantId?: string;
  domainId?: string;
  role: BetterAuthMarketplaceRole;
}): Promise<PartySession | null> {
  const { data, error } = await authClient.getSession({
    fetchOptions: authFetchOptions(input.subplatform),
  });
  if (error || !data) return null;

  if (input.role === "platform") return null;
  let capability = readPartySession(
    input.role === "subplatform_admin" ? "admin" : input.role,
    input.subplatform,
  );
  if (isLiveMarketplaceEnabled()) {
    if (!input.tenantId) throw new Error("当前子平台尚未完成 root tenant 注册");
    if (!capability) {
      capability = await establishMarketplaceSession({
        tenantId: input.tenantId,
        domainId: input.domainId,
        subplatform: input.subplatform,
        role: input.role,
      });
    }
    return capability;
  }

  // Demo mode has no domain API call. It still requires a Better Auth session and uses the
  // Better Auth user UUID as a display-only identity for local form state.
  return capability ?? {
    tenantId: input.tenantId ?? "demo",
    partyId: data.user.id,
    role: input.role === "subplatform_admin" ? "both" : input.role,
    accessToken: "demo-capability-not-for-api",
    accessTokenExpiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  };
}

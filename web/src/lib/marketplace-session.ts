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
  platformPath?: string;
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
    input.platformPath,
    data.user.id,
  );
  if (isLiveMarketplaceEnabled()) {
    if (!input.tenantId) throw new Error("当前子平台尚未完成 root tenant 注册");
    if (!capability) {
      capability = await establishMarketplaceSession({
        tenantId: input.tenantId,
        domainId: input.domainId,
        subplatform: input.subplatform,
        platformPath: input.platformPath,
        role: input.role,
        authUserId: data.user.id,
      });
    }
    return capability;
  }

  // A non-live build never fabricates a marketplace bearer or writes local-only records. The
  // caller can show a configuration notice and operators can opt into the real API explicitly.
  return capability ?? null;
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { authClient, authFetchOptions } from "../lib/auth-client";
import { clearPartySessionCache } from "../api";
import type { WorkspaceRole } from "../types";
import type { SubplatformConfig } from "../subplatform";

const AUTH_PENDING_KEY = "matchplane.auth.pending";

export interface AuthenticatedUser {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
  role?: string | null;
}

export function isTransientAuthError(error: unknown): boolean {
  if (!error || typeof error !== "object") return true;
  const status =
    typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
  return status === null || status === 408 || status === 429 || status >= 500;
}

function authSessionFailureMessage(error: unknown): string {
  const status =
    error && typeof error === "object"
      ? ((error as { status?: unknown }).status ??
        (error as { statusCode?: unknown }).statusCode)
      : null;
  return status === 429
    ? "登录状态检查过于频繁，请稍后刷新；当前会话不会被清除"
    : "暂时无法确认登录状态，请刷新后重试；当前会话不会被清除";
}

function hasRecentPendingAuthentication(): boolean {
  if (typeof window === "undefined") return false;
  const startedAt = Number.parseInt(
    window.sessionStorage.getItem(AUTH_PENDING_KEY) ?? "",
    10,
  );
  return Number.isFinite(startedAt) && Date.now() - startedAt < 15_000;
}

export function waitForAuthRetry(attempt: number): Promise<void> {
  return new Promise((resolve) =>
    window.setTimeout(resolve, (attempt + 1) * 300),
  );
}

export function requiresAuthenticatedWorkspace(role: WorkspaceRole): boolean {
  return role === "platform";
}

function loginHref(role: WorkspaceRole): string {
  if (typeof window === "undefined")
    return `/login?role=${encodeURIComponent(role)}`;
  const searchParams = new URLSearchParams(window.location.search);
  searchParams.set("role", role);
  const query = searchParams.toString();
  const next = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  return `/login?role=${encodeURIComponent(role)}&next=${encodeURIComponent(next)}`;
}

interface UseAuthSessionOptions {
  subplatform: SubplatformConfig;
  requestedRoleRef: React.MutableRefObject<WorkspaceRole>;
  setRole: (role: WorkspaceRole) => void;
  onNotice: (message: string) => void;
  onSignedOut?: () => void;
}

export function useAuthSession({
  subplatform,
  requestedRoleRef,
  setRole,
  onNotice,
  onSignedOut,
}: UseAuthSessionOptions) {
  const [authUser, setAuthUser] = useState<AuthenticatedUser | null>(null);
  const [authResolved, setAuthResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAuthResolved(false);
    const resolveSession = async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        let result: Awaited<ReturnType<typeof authClient.getSession>>;
        try {
          result = await authClient.getSession({
            fetchOptions: authFetchOptions(subplatform.slug),
          });
        } catch (error) {
          if (cancelled) return;
          if (attempt < 4) {
            await waitForAuthRetry(attempt);
            continue;
          }
          setAuthResolved(true);
          onNotice(authSessionFailureMessage(error));
          return;
        }
        if (cancelled) return;
        if (result.error) {
          if (attempt < 4 && isTransientAuthError(result.error)) {
            await waitForAuthRetry(attempt);
            continue;
          }
          setAuthResolved(true);
          onNotice(authSessionFailureMessage(result.error));
          return;
        }

        const user = result.data?.user as AuthenticatedUser | undefined;
        if (!user?.id && hasRecentPendingAuthentication() && attempt < 4) {
          await waitForAuthRetry(attempt);
          continue;
        }
        if (typeof window !== "undefined") {
          window.sessionStorage.removeItem(AUTH_PENDING_KEY);
        }
        setAuthUser(user?.id ? user : null);
        setAuthResolved(true);
        const requestedRole = requestedRoleRef.current;
        const userRole = user?.role;
        const isRootManager =
          userRole === "rootSuperAdmin" || userRole === "rootAdmin";
        if (requiresAuthenticatedWorkspace(requestedRole) && !user) {
          setRole("buyer");
          if (typeof window !== "undefined") {
            window.location.assign(loginHref(requestedRole));
          }
          return;
        }
        if (requestedRole === "platform" && !isRootManager) {
          setRole("buyer");
          onNotice("当前账号没有商城运营权限");
          return;
        }
        if (user && requiresAuthenticatedWorkspace(requestedRole)) {
          setRole(requestedRole);
        }
        return;
      }
    };
    void resolveSession();
    return () => {
      cancelled = true;
    };
  }, [subplatform.slug, requestedRoleRef, setRole, onNotice]);

  const openSignIn = useCallback(
    (role: WorkspaceRole = "buyer") => {
      if (typeof window !== "undefined") {
        window.location.assign(loginHref(role));
      }
    },
    [],
  );

  const signOut = useCallback(
    async (signedOutMessage: string, signOutFailedMessage: string) => {
      try {
        const result = await authClient.signOut({
          fetchOptions: authFetchOptions(subplatform.slug),
        });
        if (result.error)
          throw new Error(result.error.message || "退出登录失败");
        clearPartySessionCache();
        setAuthUser(null);
        setRole("buyer");
        requestedRoleRef.current = "buyer";
        if (typeof window !== "undefined") {
          const searchParams = new URLSearchParams(window.location.search);
          searchParams.delete("role");
          const query = searchParams.toString();
          const next = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
          window.history.replaceState(null, "", next);
        }
        onSignedOut?.();
        onNotice(signedOutMessage);
      } catch (error) {
        onNotice(
          error instanceof Error ? error.message : signOutFailedMessage,
        );
      }
    },
    [subplatform.slug, requestedRoleRef, setRole, onNotice, onSignedOut],
  );

  return {
    authUser,
    setAuthUser,
    authResolved,
    openSignIn,
    signOut,
  };
}

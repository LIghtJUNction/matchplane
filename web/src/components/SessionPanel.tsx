"use client";

import { useCallback, useEffect, useState } from "react";
import { Laptop, LogOut, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@appica/ui-react/button";

import { authClient, authFetchOptions } from "../lib/auth-client";
import type { InterfaceLocale } from "../lib/preferences";
import type { SubplatformConfig } from "../subplatform";

interface SessionRecord {
  id: string;
  token: string;
  createdAt: string | null;
  updatedAt: string | null;
  expiresAt: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

interface SessionPanelProps {
  locale: InterfaceLocale;
  subplatform: SubplatformConfig;
  onNotice: (message: string) => void;
}

/** Better Auth is the sole authority for durable session listing and revocation. */
export function SessionPanel({ locale, subplatform, onNotice }: SessionPanelProps) {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
  const copy = sessionCopy(locale);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [current, response] = await Promise.all([
        authClient.getSession({ fetchOptions: authFetchOptions(subplatform.slug) }),
        fetch("/api/auth/list-sessions", {
          credentials: "include",
          headers: { accept: "application/json", ...authFetchOptions(subplatform.slug).headers },
        }),
      ]);
      if (!response.ok) throw new SessionActionError(response.status);
      const body = await response.json() as unknown;
      setCurrentSessionId(typeof current.data?.session?.id === "string" ? current.data.session.id : null);
      setSessions(Array.isArray(body) ? body.flatMap((item): SessionRecord[] => {
        if (!item || typeof item !== "object") return [];
        const record = item as Record<string, unknown>;
        if (typeof record.id !== "string" || !record.id || typeof record.token !== "string" || !record.token) return [];
        return [{
          id: record.id,
          token: record.token,
          createdAt: dateValue(record.createdAt),
          updatedAt: dateValue(record.updatedAt),
          expiresAt: dateValue(record.expiresAt),
          ipAddress: typeof record.ipAddress === "string" ? record.ipAddress : null,
          userAgent: typeof record.userAgent === "string" ? record.userAgent : null,
        }];
      }) : []);
    } catch (error) {
      onNotice(error instanceof SessionActionError && error.status === 403 ? copy.reauthenticate : copy.loadFailed);
    } finally {
      setLoading(false);
    }
  }, [copy.loadFailed, copy.reauthenticate, onNotice, subplatform.slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (session: SessionRecord) => {
    if (revoking) return;
    setRevoking(session.id);
    try {
      const response = await fetch("/api/auth/revoke-session", {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json", "content-type": "application/json", ...authFetchOptions(subplatform.slug).headers },
        body: JSON.stringify({ token: session.token }),
      });
      if (!response.ok) throw new SessionActionError(response.status);
      await load();
      onNotice(copy.revoked);
    } catch (error) {
      onNotice(error instanceof SessionActionError && error.status === 403 ? copy.reauthenticate : copy.revokeFailed);
    } finally {
      setRevoking(null);
    }
  };

  const revokeOthers = async () => {
    if (revoking) return;
    setRevoking("others");
    try {
      const response = await fetch("/api/auth/revoke-other-sessions", {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json", ...authFetchOptions(subplatform.slug).headers },
      });
      if (!response.ok) throw new SessionActionError(response.status);
      await load();
      onNotice(copy.othersRevoked);
    } catch (error) {
      onNotice(error instanceof SessionActionError && error.status === 403 ? copy.reauthenticate : copy.revokeFailed);
    } finally {
      setRevoking(null);
    }
  };

  const otherSessions = sessions.filter((session) => session.id !== currentSessionId);

  return (
    <section className="workspace-settings-section session-panel" aria-labelledby="session-panel-title">
      <div className="workspace-settings-section-heading">
        <div>
          <h3 id="session-panel-title">{copy.title}</h3>
          <p>{copy.description}</p>
        </div>
        <ShieldCheck size={20} aria-hidden="true" />
      </div>
      <div className="session-panel-actions">
        <Button className="min-h-11" size="md" variant="outline" type="button" onClick={() => void load()} disabled={loading || Boolean(revoking)}>
          <RefreshCw size={16} aria-hidden="true" />
          {copy.refresh}
        </Button>
        {otherSessions.length ? <Button className="min-h-11" size="md" variant="outline" type="button" onClick={() => void revokeOthers()} disabled={loading || Boolean(revoking)}>
          <LogOut size={16} aria-hidden="true" />
          {revoking === "others" ? copy.revoking : copy.revokeOthers}
        </Button> : null}
      </div>
      {!loading && sessions.length ? (
        <ul className="session-list" aria-label={copy.title}>
          {sessions.map((session) => {
            const isCurrent = session.id === currentSessionId;
            return (
              <li key={session.id}>
                <Laptop size={18} aria-hidden="true" />
                <span className="session-list-copy">
                  <strong>{isCurrent ? copy.current : describeDevice(session.userAgent, locale)}</strong>
                  <small>{session.updatedAt ? `${copy.activeAt} ${formatDate(session.updatedAt, locale)}` : copy.activeSession}</small>
                </span>
                {!isCurrent ? <Button className="min-h-11 min-w-11" variant="outline" size="icon-sm" type="button" aria-label={`${copy.revoke} ${describeDevice(session.userAgent, locale)}`} disabled={Boolean(revoking)} onClick={() => void revoke(session)}><LogOut size={16} aria-hidden="true" /></Button> : null}
              </li>
            );
          })}
        </ul>
      ) : !loading ? <p className="session-empty">{copy.empty}</p> : null}
    </section>
  );
}

class SessionActionError extends Error {
  constructor(readonly status: number) {
    super(`session action failed (${status})`);
  }
}

function dateValue(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime()) ? value : null;
}

function formatDate(value: string, locale: InterfaceLocale): string {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function describeDevice(userAgent: string | null, locale: InterfaceLocale): string {
  const browser = /Firefox/i.test(userAgent ?? "") ? "Firefox" : /Edg/i.test(userAgent ?? "") ? "Edge" : /Chrome|Chromium/i.test(userAgent ?? "") ? "Chrome" : /Safari/i.test(userAgent ?? "") ? "Safari" : null;
  const system = /Android/i.test(userAgent ?? "") ? "Android" : /iPhone|iPad|iOS/i.test(userAgent ?? "") ? "iOS" : /Windows/i.test(userAgent ?? "") ? "Windows" : /Mac OS X/i.test(userAgent ?? "") ? "macOS" : /Linux/i.test(userAgent ?? "") ? "Linux" : null;
  if (browser && system) return `${browser} · ${system}`;
  if (browser) return browser;
  return locale === "zh" ? "其他设备" : "Other device";
}

function sessionCopy(locale: InterfaceLocale) {
  return locale === "zh" ? {
    title: "会话管理",
    description: "查看已登录设备，并可安全退出其他设备。",
    refresh: "刷新",
    revokeOthers: "退出其他设备",
    revoking: "正在退出…",
    current: "当前设备",
    activeAt: "最近活动：",
    activeSession: "活跃会话",
    revoke: "退出",
    empty: "没有可管理的其他会话。",
    revoked: "该设备已退出登录。",
    othersRevoked: "其他设备已全部退出登录。",
    loadFailed: "会话列表暂时无法读取。",
    revokeFailed: "退出会话失败，请稍后重试。",
    reauthenticate: "为保护账号安全，请重新登录后再管理会话。",
  } : {
    title: "Sessions",
    description: "Review signed-in devices and safely sign out other devices.",
    refresh: "Refresh",
    revokeOthers: "Sign out other devices",
    revoking: "Signing out…",
    current: "This device",
    activeAt: "Last active: ",
    activeSession: "Active session",
    revoke: "Sign out",
    empty: "No other sessions to manage.",
    revoked: "That device was signed out.",
    othersRevoked: "All other devices were signed out.",
    loadFailed: "Session list is temporarily unavailable.",
    revokeFailed: "Could not sign out the session. Try again later.",
    reauthenticate: "For account security, sign in again before managing sessions.",
  };
}

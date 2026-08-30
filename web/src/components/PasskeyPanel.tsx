"use client";

import { useCallback, useEffect, useState } from "react";
import { Fingerprint, Trash2 } from "lucide-react";
import { Button } from "@appica/ui-react/button";

import { authClient, authFetchOptions } from "../lib/auth-client";
import type { InterfaceLocale } from "../lib/preferences";
import type { SubplatformConfig } from "../subplatform";

interface PasskeyRecord {
  id: string;
  name: string | null;
  createdAt: string | null;
}

interface PasskeyPanelProps {
  locale: InterfaceLocale;
  subplatform: SubplatformConfig;
  accountLabel?: string | null;
  onNotice: (message: string) => void;
}

/** Account-owned WebAuthn credentials. Better Auth remains the sole credential authority. */
export function PasskeyPanel({
  locale,
  subplatform,
  accountLabel,
  onNotice,
}: PasskeyPanelProps) {
  const [passkeys, setPasskeys] = useState<PasskeyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [binding, setBinding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const copy = passkeyCopy(locale);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/auth/passkey/list-user-passkeys", {
        credentials: "include",
        headers: {
          accept: "application/json",
          ...authFetchOptions(subplatform.slug).headers,
        },
      });
      if (!response.ok) throw new Error("list passkeys failed");
      const body = (await response.json()) as unknown;
      const loaded = Array.isArray(body)
        ? body.flatMap((item): PasskeyRecord[] => {
            if (!item || typeof item !== "object") return [];
            const record = item as {
              id?: unknown;
              name?: unknown;
              createdAt?: unknown;
            };
            if (typeof record.id !== "string" || !record.id) return [];
            return [
              {
                id: record.id,
                name:
                  typeof record.name === "string" && record.name.trim()
                    ? record.name.trim()
                    : null,
                createdAt:
                  typeof record.createdAt === "string"
                    ? record.createdAt
                    : null,
              },
            ];
          })
        : [];
      const legacy = loaded.filter((passkey) =>
        isLegacyPasskeyName(passkey.name),
      );
      const renamed =
        accountLabel && legacy.length
          ? loaded.map((passkey) => {
              const index = legacy.findIndex(
                (legacyPasskey) => legacyPasskey.id === passkey.id,
              );
              if (index < 0) return passkey;
              const suffix = legacy.length > 1 ? ` · ${index + 1}` : "";
              return {
                ...passkey,
                name: `${copy.thisDevice} · ${accountLabel}${suffix}`.slice(
                  0,
                  128,
                ),
              };
            })
          : loaded;
      setPasskeys(renamed);
      if (accountLabel && legacy.length) {
        await Promise.all(
          legacy.map(async (passkey, index) => {
            const suffix = legacy.length > 1 ? ` · ${index + 1}` : "";
            try {
              await fetch("/api/auth/update-passkey", {
                method: "POST",
                credentials: "include",
                headers: {
                  accept: "application/json",
                  "content-type": "application/json",
                  ...authFetchOptions(subplatform.slug).headers,
                },
                body: JSON.stringify({
                  id: passkey.id,
                  name: `${copy.thisDevice} · ${accountLabel}${suffix}`.slice(
                    0,
                    128,
                  ),
                }),
              });
            } catch {
              // Renaming legacy credentials is best-effort and must not hide the usable key.
            }
            return undefined;
          }),
        );
      }
    } catch {
      onNotice(copy.loadFailed);
    } finally {
      setLoading(false);
    }
  }, [copy.loadFailed, onNotice, subplatform.slug]);

  useEffect(() => {
    setUnsupported(
      typeof window === "undefined" || !window.PublicKeyCredential,
    );
    void load();
  }, [load]);

  const bind = async () => {
    if (unsupported || binding) return;
    setBinding(true);
    try {
      const result = await authClient.passkey.addPasskey({
        name: accountLabel
          ? `${copy.thisDevice} · ${accountLabel}`.slice(0, 128)
          : copy.thisDevice,
        fetchOptions: authFetchOptions(subplatform.slug),
      });
      if (result.error)
        throw new Error(passkeyFailureMessage(result.error, copy));
      await load();
      onNotice(copy.bound);
    } catch (error) {
      onNotice(
        error instanceof Error && error.message
          ? passkeyFailureMessage(error, copy)
          : copy.bindFailed,
      );
    } finally {
      setBinding(false);
    }
  };

  const remove = async (id: string) => {
    if (removing) return;
    setRemoving(id);
    try {
      const response = await fetch("/api/auth/passkey/delete-passkey", {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...authFetchOptions(subplatform.slug).headers,
        },
        body: JSON.stringify({ id }),
      });
      if (!response.ok) throw new Error(copy.removeFailed);
      await load();
      onNotice(copy.removed);
    } catch (error) {
      onNotice(
        error instanceof Error && error.message
          ? error.message
          : copy.removeFailed,
      );
    } finally {
      setRemoving(null);
    }
  };

  return (
    <section
      className="workspace-settings-section passkey-panel"
      aria-labelledby="passkey-panel-title"
    >
      <div className="workspace-settings-section-heading">
        <div>
          <h3 id="passkey-panel-title">{copy.title}</h3>
          <p>{copy.description}</p>
        </div>
        <Fingerprint size={20} aria-hidden="true" />
      </div>
      <div className="passkey-panel-actions">
        <Button
          className="min-h-11"
          size="md"
          type="button"
          variant="outline"
          onClick={() => void bind()}
          disabled={binding || loading || unsupported}
        >
          <Fingerprint size={16} aria-hidden="true" />
          {binding ? copy.binding : copy.bind}
        </Button>
        {unsupported ? <small>{copy.unsupported}</small> : null}
      </div>
      {passkeys.length ? (
        <ul className="passkey-list" aria-label={copy.title}>
          {passkeys.map((passkey) => (
            <li key={passkey.id}>
              <span>
                <strong>{passkey.name || copy.unnamed}</strong>
                <small>
                  {passkey.createdAt
                    ? formatDate(passkey.createdAt, locale)
                    : copy.boundCredential}
                </small>
              </span>
              <Button
                className="min-h-11 min-w-11"
                type="button"
                variant="outline"
                size="icon-sm"
                aria-label={`${copy.remove} ${passkey.name || copy.unnamed}`}
                disabled={removing === passkey.id}
                onClick={() => void remove(passkey.id)}
              >
                <Trash2 size={16} aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      ) : !loading ? (
        <p className="passkey-empty">{copy.empty}</p>
      ) : null}
    </section>
  );
}

function formatDate(value: string, locale: InterfaceLocale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
    dateStyle: "medium",
  }).format(date);
}

function isLegacyPasskeyName(value: string | null): boolean {
  return (
    value === "当前设备" ||
    value === "This device" ||
    value === "未命名设备" ||
    value === "Unnamed device"
  );
}

function passkeyCopy(locale: InterfaceLocale) {
  return locale === "zh"
    ? {
        title: "Passkey",
        description: "用当前设备的指纹、面容或系统解锁方式登录。",
        bind: "绑定当前设备",
        binding: "正在绑定…",
        thisDevice: "当前设备",
        unsupported: "当前浏览器不支持 Passkey。",
        empty: "尚未绑定 Passkey。",
        unnamed: "未命名设备",
        boundCredential: "已绑定的登录凭据",
        remove: "移除",
        bound: "Passkey 已绑定。",
        removed: "Passkey 已移除。",
        loadFailed: "Passkey 状态暂时无法读取。",
        bindFailed: "Passkey 绑定没有完成，请再试一次。",
        permissionNeeded:
          "浏览器没有完成 Passkey 请求。请启用系统 Passkey，或连接手机/USB 安全密钥后重试。",
        removeFailed: "Passkey 移除失败，请稍后重试。",
      }
    : {
        title: "Passkey",
        description:
          "Use this device's fingerprint, face, or system unlock to sign in.",
        bind: "Bind this device",
        binding: "Binding…",
        thisDevice: "This device",
        unsupported: "This browser does not support passkeys.",
        empty: "No passkey is bound yet.",
        unnamed: "Unnamed device",
        boundCredential: "Bound sign-in credential",
        remove: "Remove",
        bound: "Passkey bound.",
        removed: "Passkey removed.",
        loadFailed: "Passkey status is temporarily unavailable.",
        bindFailed: "Passkey binding did not complete. Try again.",
        permissionNeeded:
          "The browser did not complete the passkey request. Enable a system passkey, or connect a phone or USB security key and try again.",
        removeFailed: "Could not remove the passkey. Try again later.",
      };
}

function passkeyFailureMessage(
  error: { code?: unknown; message?: unknown } | Error,
  copy: ReturnType<typeof passkeyCopy>,
): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error.message === "string"
        ? error.message
        : "";
  const code =
    !(error instanceof Error) && typeof error.code === "string"
      ? error.code
      : "";
  if (
    /notallowed|not allowed|cancelled|permission/i.test(message) ||
    /CANCELLED|NOT_ALLOWED/i.test(code)
  ) {
    return copy.permissionNeeded;
  }
  return copy.bindFailed;
}

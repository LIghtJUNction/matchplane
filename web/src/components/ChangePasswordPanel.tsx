"use client";

import { useState, type SyntheticEvent } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@appica/ui-react/button";

import { authClient } from "../lib/auth-client";
import type { InterfaceLocale } from "../lib/preferences";

/** Password maintenance belongs to account security, never to a store workspace. */
export function ChangePasswordPanel({
  email,
  locale,
  onNotice,
}: {
  email?: string | null;
  locale: InterfaceLocale;
  onNotice: (message: string) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [revokeOtherSessions, setRevokeOtherSessions] = useState(true);
  const [saving, setSaving] = useState(false);
  const english = locale === "en";

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (newPassword.length < 8 || newPassword.length > 128) {
      onNotice(
        english
          ? "The new password must be 8–128 characters."
          : "新密码需要 8–128 个字符",
      );
      return;
    }
    if (newPassword !== confirmPassword) {
      onNotice(
        english ? "The new passwords do not match." : "两次输入的新密码不一致",
      );
      return;
    }
    setSaving(true);
    try {
      const result = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions,
      });
      if (result.error)
        throw new Error(
          result.error.message ||
            (english ? "Could not change password." : "密码修改失败"),
        );
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      onNotice(
        revokeOtherSessions
          ? english
            ? "Password changed. Other devices have been signed out."
            : "密码已修改，其他设备已退出登录"
          : english
            ? "Password changed."
            : "密码已修改",
      );
    } catch (error) {
      onNotice(
        error instanceof Error
          ? error.message
          : english
            ? "Could not change password."
            : "密码修改失败",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      className="workspace-settings-section password-settings-section"
      aria-labelledby="password-settings-title"
    >
      <div className="workspace-settings-section-heading">
        <span className="password-settings-icon">
          <KeyRound size={17} aria-hidden="true" />
        </span>
        <div>
          <h3 id="password-settings-title">
            {english ? "Change password" : "修改密码"}
          </h3>
          <p>
            {english
              ? "Confirm your current password, then choose a new one."
              : "验证当前密码后设置新密码。"}
          </p>
        </div>
      </div>
      <form className="password-settings-form" onSubmit={submit}>
        <label htmlFor="account-current-password">
          <span>{english ? "Current password" : "当前密码"}</span>
          <input
            id="account-current-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            minLength={8}
            maxLength={128}
            required
          />
        </label>
        <label htmlFor="account-new-password">
          <span>{english ? "New password" : "新密码"}</span>
          <input
            id="account-new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            minLength={8}
            maxLength={128}
            required
          />
        </label>
        <label htmlFor="account-confirm-password">
          <span>{english ? "Confirm new password" : "再次输入新密码"}</span>
          <input
            id="account-confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            minLength={8}
            maxLength={128}
            required
          />
        </label>
        <label className="password-settings-revoke">
          <input
            type="checkbox"
            checked={revokeOtherSessions}
            onChange={(event) => setRevokeOtherSessions(event.target.checked)}
          />
          <span>
            {english
              ? "Sign out other devices after changing the password"
              : "修改后退出其他设备"}
          </span>
        </label>
        <div className="password-settings-actions">
          <a
            href={`/login?reset=1${
              email ? `&email=${encodeURIComponent(email)}` : ""
            }`}
          >
            {english ? "Forgot password?" : "忘记密码？"}
          </a>
          <Button
            type="submit"
            disabled={
              saving || !currentPassword || !newPassword || !confirmPassword
            }
          >
            {saving
              ? english
                ? "Changing…"
                : "修改中…"
              : english
                ? "Change password"
                : "修改密码"}
          </Button>
        </div>
      </form>
    </section>
  );
}

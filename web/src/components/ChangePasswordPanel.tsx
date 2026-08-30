"use client";

import { useState, type SyntheticEvent } from "react";
import {
  Alert,
  AlertDescription,
  AlertIcon,
  AlertTitle,
} from "@appica/ui-react/alert";
import { Button } from "@appica/ui-react/button";
import { AlertTriangle, CheckCircle2, KeyRound } from "lucide-react";

import { authClient } from "../lib/auth-client";
import type { InterfaceLocale } from "../lib/preferences";

const PASSWORD_COPY = {
  en: {
    title: "Change password",
    intro: "Confirm your current password, then choose a new one.",
    current: "Current password",
    next: "New password",
    confirm: "Confirm new password",
    revoke: "Sign out other devices after changing the password",
    forgot: "Forgot password?",
    changing: "Changing…",
    change: "Change password",
    lengthNotice: "The new password must be 8–128 characters.",
    lengthTitle: "Check the new password",
    lengthDescription: "Use 8–128 characters, then try again.",
    mismatchNotice: "The new passwords do not match.",
    mismatchTitle: "Passwords do not match",
    mismatchDescription:
      "Enter the same new password in both fields, then try again.",
    apiFallback: "Could not change password.",
    apiTitle: "Password not changed",
    apiRecovery: "Check your current password and try again.",
    successNotice: "Password changed.",
    successRevokeNotice:
      "Password changed. Other devices have been signed out.",
    successTitle: "Password changed",
    successDescription: "Use the new password the next time you sign in.",
    successRevokeDescription:
      "Other devices are signed out. Use the new password the next time you sign in.",
  },
  zh: {
    title: "修改密码",
    intro: "验证当前密码后设置新密码。",
    current: "当前密码",
    next: "新密码",
    confirm: "再次输入新密码",
    revoke: "修改后退出其他设备",
    forgot: "忘记密码？",
    changing: "修改中…",
    change: "修改密码",
    lengthNotice: "新密码需要 8–128 个字符",
    lengthTitle: "请检查新密码",
    lengthDescription: "请输入 8–128 个字符，然后重试。",
    mismatchNotice: "两次输入的新密码不一致",
    mismatchTitle: "两次密码不一致",
    mismatchDescription: "请在两个新密码输入框中填写相同内容，然后重试。",
    apiFallback: "密码修改失败",
    apiTitle: "密码未修改",
    apiRecovery: "请检查当前密码后重试。",
    successNotice: "密码已修改",
    successRevokeNotice: "密码已修改，其他设备已退出登录",
    successTitle: "密码已修改",
    successDescription: "下次登录时请使用新密码。",
    successRevokeDescription: "其他设备已退出登录。下次登录时请使用新密码。",
  },
} as const;

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
  const [feedback, setFeedback] = useState<{
    type: "error" | "success";
    title: string;
    description: string;
  } | null>(null);
  const copy = PASSWORD_COPY[locale];

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFeedback(null);
    if (newPassword.length < 8 || newPassword.length > 128) {
      setFeedback({
        type: "error",
        title: copy.lengthTitle,
        description: copy.lengthDescription,
      });
      onNotice(copy.lengthNotice);
      return;
    }
    if (newPassword !== confirmPassword) {
      setFeedback({
        type: "error",
        title: copy.mismatchTitle,
        description: copy.mismatchDescription,
      });
      onNotice(copy.mismatchNotice);
      return;
    }
    setSaving(true);
    try {
      const result = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions,
      });
      if (result.error) {
        throw new Error(result.error.message || copy.apiFallback);
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      const message = revokeOtherSessions
        ? copy.successRevokeNotice
        : copy.successNotice;
      setFeedback({
        type: "success",
        title: copy.successTitle,
        description: revokeOtherSessions
          ? copy.successRevokeDescription
          : copy.successDescription,
      });
      onNotice(message);
    } catch (error) {
      const message = error instanceof Error ? error.message : copy.apiFallback;
      setFeedback({
        type: "error",
        title: copy.apiTitle,
        description: `${message} ${copy.apiRecovery}`,
      });
      onNotice(message);
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
          <h3 id="password-settings-title">{copy.title}</h3>
          <p>{copy.intro}</p>
        </div>
      </div>
      <form className="password-settings-form" onSubmit={submit}>
        <label htmlFor="account-current-password">
          <span>{copy.current}</span>
          <input
            id="account-current-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => {
              setCurrentPassword(event.target.value);
              setFeedback(null);
            }}
            minLength={8}
            maxLength={128}
            required
          />
        </label>
        <label htmlFor="account-new-password">
          <span>{copy.next}</span>
          <input
            id="account-new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => {
              setNewPassword(event.target.value);
              setFeedback(null);
            }}
            minLength={8}
            maxLength={128}
            required
          />
        </label>
        <label htmlFor="account-confirm-password">
          <span>{copy.confirm}</span>
          <input
            id="account-confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(event) => {
              setConfirmPassword(event.target.value);
              setFeedback(null);
            }}
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
          <span>{copy.revoke}</span>
        </label>
        <div className="password-settings-actions">
          <a
            href={`/login?reset=1${
              email ? `&email=${encodeURIComponent(email)}` : ""
            }`}
          >
            {copy.forgot}
          </a>
          <Button
            className="min-h-11"
            size="md"
            type="submit"
            disabled={
              saving || !currentPassword || !newPassword || !confirmPassword
            }
          >
            {saving ? copy.changing : copy.change}
          </Button>
        </div>
      </form>
      {feedback ? (
        <Alert
          variant={feedback.type === "error" ? "error" : "success"}
          role={feedback.type === "error" ? "alert" : "status"}
          layout="inline"
        >
          <AlertIcon>
            {feedback.type === "error" ? (
              <AlertTriangle aria-hidden="true" />
            ) : (
              <CheckCircle2 aria-hidden="true" />
            )}
          </AlertIcon>
          <AlertTitle as="div">{feedback.title}</AlertTitle>
          <AlertDescription>{feedback.description}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}

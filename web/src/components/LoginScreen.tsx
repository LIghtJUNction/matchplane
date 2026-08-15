"use client";

import { FormEvent, useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, LockKeyhole, Sparkles } from "lucide-react";

import {
  establishMarketplaceSession,
  isLiveMarketplaceEnabled,
  type BetterAuthMarketplaceRole,
} from "../api";
import { authClient, authFetchOptions } from "../lib/auth-client";
import { resolveSubplatform, type SubplatformConfig } from "../subplatform";

export function LoginScreen() {
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [next, setNext] = useState("/");
  const [role, setRole] = useState<BetterAuthMarketplaceRole>("buyer");
  const [subplatform, setSubplatform] = useState<SubplatformConfig>(() => resolveSubplatform());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedRole = params.get("role");
    setRole(
      requestedRole === "seller"
        ? "seller"
        : requestedRole === "platform"
          ? "platform"
          : requestedRole === "subplatform_admin" || requestedRole === "admin"
            ? "subplatform_admin"
            : "buyer",
    );
    setNext(safeNext(params.get("next")));
    setSubplatform(resolveSubplatform(window.location.pathname));
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedName = displayName.trim();
    if (!isEmail(normalizedEmail)) {
      setError("请输入有效的邮箱地址。");
      return;
    }
    if (password.length < 8) {
      setError("密码至少需要 8 位，由 Better Auth 负责安全存储和验证。");
      return;
    }
    if (mode === "sign-up" && normalizedName.length < 2) {
      setError("请先留下一个称呼，方便匹配双方识别彼此。");
      return;
    }

    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const options = authFetchOptions(subplatform.slug);
      const result = mode === "sign-up"
        ? await authClient.signUp.email({
            name: normalizedName,
            email: normalizedEmail,
            password,
            callbackURL: next,
            fetchOptions: options,
          })
        : await authClient.signIn.email({
            email: normalizedEmail,
            password,
            callbackURL: next,
            fetchOptions: options,
          });
      if (result.error) {
        throw new Error(result.error.message || "Better Auth 未完成登录");
      }
      if (mode === "sign-up") {
        setNotice("验证邮件已由 Better Auth 发出。请完成邮箱验证后再登录。");
        setSubmitting(false);
        return;
      }
      if (isLiveMarketplaceEnabled() && role !== "platform") {
        if (!subplatform.tenantId) throw new Error("当前子平台尚未完成 root tenant 注册");
        await establishMarketplaceSession({
          tenantId: subplatform.tenantId,
          domainId: subplatform.domainId,
          subplatform: subplatform.slug,
          role,
        });
      }
      window.location.assign(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Better Auth 登录暂时没有完成，请稍后再试。");
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <a className="login-back" href="/">
        <ArrowLeft size={16} aria-hidden="true" /> 返回 MatchPlane
      </a>
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-mark" aria-hidden="true"><Sparkles size={19} /></div>
        <span className="eyebrow">Better Auth · {mode === "sign-in" ? "邮箱登录" : "创建账号"}</span>
        <h1 id="login-title">用一个邮箱，<br />继续你的匹配。</h1>
        <p className="login-intro">密码、会话、邮箱验证和重置全部由 Better Auth 处理；当前子平台只获得自己的组织权限。</p>
        <form className="login-form" onSubmit={submit}>
          {mode === "sign-up" ? (
            <label>
              <span>怎么称呼你</span>
              <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" placeholder="例如：林先生 / Mira" autoFocus />
            </label>
          ) : null}
          <label htmlFor="login-email"><span>邮箱地址</span><input id="login-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" placeholder="name@example.com" autoFocus={mode === "sign-in"} /></label>
          <label htmlFor="login-password"><span>密码</span><input id="login-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "sign-up" ? "new-password" : "current-password"} placeholder="至少 8 位" /></label>
          {error ? <p className="login-error" role="alert">{error}</p> : null}
          {notice ? <p className="login-notice" role="status">{notice}</p> : null}
          <button className="button button-dark login-submit" type="submit" disabled={submitting}>
            {submitting ? "Better Auth 处理中…" : mode === "sign-in" ? "登录并继续" : "创建并验证邮箱"}
            {!submitting ? <ArrowRight size={17} aria-hidden="true" /> : null}
          </button>
        </form>
        <button className="login-mode-toggle" type="button" onClick={() => { setMode(mode === "sign-in" ? "sign-up" : "sign-in"); setError(null); setNotice(null); }}>
          {mode === "sign-in" ? "还没有账号？创建一个" : "已经有账号？返回登录"}
        </button>
        <p className="login-privacy"><LockKeyhole size={14} aria-hidden="true" /> 联系方式加密保存，撮合前不会展示给对方。</p>
      </section>
    </main>
  );
}

function isEmail(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function safeNext(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

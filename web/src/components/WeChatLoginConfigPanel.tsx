"use client";

import { useEffect, useState } from "react";
import { Save, ShieldCheck } from "lucide-react";
import { Input } from "@appica/ui-react/input";

import {
  getWeChatOAuthConfig,
  saveWeChatOAuthConfig,
  type WeChatOAuthConfig,
} from "../api";
import { SectionHeading } from "./Primitives";

// Official WeChat Open Platform "website application" QR-code login endpoints.
// The server-side defaults live in src/lib/wechat-oauth-config.ts; these mirror
// them so the form is pre-filled before any configuration has been saved.
const DEFAULT_AUTHORIZATION_URL =
  "https://open.weixin.qq.com/connect/qrconnect#wechat_redirect";
const DEFAULT_TOKEN_URL = "https://api.weixin.qq.com/sns/oauth2/access_token";
const DEFAULT_USERINFO_URL = "https://api.weixin.qq.com/sns/userinfo";
const DEFAULT_SCOPES = "snsapi_login";

export function WeChatLoginConfigPanel({
  rootRole,
  onNotice,
}: {
  rootRole?: string | null;
  onNotice: (message: string) => void;
}) {
  const canEdit = rootRole === "rootSuperAdmin";
  const [config, setConfig] = useState<WeChatOAuthConfig | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [authorizationUrl, setAuthorizationUrl] = useState(
    DEFAULT_AUTHORIZATION_URL,
  );
  const [tokenUrl, setTokenUrl] = useState(DEFAULT_TOKEN_URL);
  const [userInfoUrl, setUserInfoUrl] = useState(DEFAULT_USERINFO_URL);
  const [scopes, setScopes] = useState(DEFAULT_SCOPES);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);

  useEffect(() => {
    let mounted = true;
    void getWeChatOAuthConfig()
      .then((current) => {
        if (mounted && current) apply(current);
      })
      .catch((error) => {
        if (mounted)
          onNotice(
            error instanceof Error ? error.message : "微信扫码登录配置读取失败",
          );
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [onNotice]);

  const save = async () => {
    if (!canEdit) return;
    setSaving(true);
    try {
      const result = await saveWeChatOAuthConfig({
        enabled,
        appId,
        appSecret: appSecret || undefined,
        authorizationUrl: authorizationUrl || undefined,
        tokenUrl: tokenUrl || undefined,
        userInfoUrl: userInfoUrl || undefined,
        scopes: scopes
          .split(/[\s,]+/)
          .map((scope) => scope.trim())
          .filter(Boolean),
      });
      apply(result.config);
      setAppSecret("");
      setRestartRequired(result.restartRequired);
      onNotice("微信扫码登录配置已保存");
    } catch (error) {
      onNotice(
        error instanceof Error ? error.message : "微信扫码登录配置保存失败",
      );
    } finally {
      setSaving(false);
    }
  };

  function apply(current: WeChatOAuthConfig) {
    setConfig(current);
    setEnabled(current.enabled);
    setAppId(current.appId);
    setAuthorizationUrl(current.authorizationUrl);
    setTokenUrl(current.tokenUrl);
    setUserInfoUrl(current.userInfoUrl);
    setScopes(current.scopes.join(", "));
  }

  return (
    <section
      className="surface national-identity-config"
      aria-labelledby="wechat-login-title"
    >
      <SectionHeading title="微信扫码登录" titleId="wechat-login-title" />
      <p className="subplatform-intro">
        接入微信开放平台的「网站应用」扫码登录。请先在开放平台创建网站应用，并把本商城域名加入授权回调域；回调路径为
        /api/auth/callback/wechat。
      </p>
      <div className="seller-upload-form">
        <label className="email-enabled seller-upload-wide">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!canEdit || loading}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          在登录页显示微信扫码登录
        </label>
        <label htmlFor="wechat-login-app-id">
          <span>AppID</span>
          <Input
            id="wechat-login-app-id"
            value={appId}
            disabled={!canEdit || loading}
            onChange={(event) => setAppId(event.target.value)}
            autoComplete="off"
            placeholder="<appid>"
          />
        </label>
        <label htmlFor="wechat-login-app-secret">
          <span>AppSecret</span>
          <Input
            id="wechat-login-app-secret"
            type="password"
            value={appSecret}
            disabled={!canEdit || loading}
            onChange={(event) => setAppSecret(event.target.value)}
            autoComplete="new-password"
            placeholder={
              config?.credentialConfigured
                ? "留空则保持当前密钥"
                : "填写开放平台分配的 AppSecret"
            }
          />
        </label>
        <label htmlFor="wechat-login-scopes">
          <span>Scopes</span>
          <Input
            id="wechat-login-scopes"
            value={scopes}
            disabled={!canEdit || loading}
            onChange={(event) => setScopes(event.target.value)}
            placeholder={DEFAULT_SCOPES}
          />
        </label>
        <div className="national-identity-endpoints seller-upload-wide">
          <label htmlFor="wechat-login-authorize">
            <span>授权地址</span>
            <Input
              id="wechat-login-authorize"
              value={authorizationUrl}
              disabled={!canEdit || loading}
              onChange={(event) => setAuthorizationUrl(event.target.value)}
              inputMode="url"
              placeholder={DEFAULT_AUTHORIZATION_URL}
            />
          </label>
          <label htmlFor="wechat-login-token">
            <span>令牌地址</span>
            <Input
              id="wechat-login-token"
              value={tokenUrl}
              disabled={!canEdit || loading}
              onChange={(event) => setTokenUrl(event.target.value)}
              inputMode="url"
              placeholder={DEFAULT_TOKEN_URL}
            />
          </label>
          <label htmlFor="wechat-login-userinfo">
            <span>用户信息地址</span>
            <Input
              id="wechat-login-userinfo"
              value={userInfoUrl}
              disabled={!canEdit || loading}
              onChange={(event) => setUserInfoUrl(event.target.value)}
              inputMode="url"
              placeholder={DEFAULT_USERINFO_URL}
            />
          </label>
        </div>
        <div className="seller-upload-wide root-email-actions national-identity-actions">
          <p>
            <ShieldCheck size={16} aria-hidden="true" />
            AppSecret：{config?.credentialConfigured ? "已就绪" : "尚未写入"}
          </p>
          {canEdit ? (
            <button
              className="root-email-save"
              type="button"
              disabled={saving || loading}
              onClick={() => void save()}
            >
              <Save size={16} aria-hidden="true" />
              {saving ? "保存中…" : "保存配置"}
            </button>
          ) : null}
        </div>
      </div>
      {restartRequired ? (
        <p className="national-identity-restart" role="status">
          配置已保存。微信扫码登录会在下一次 Web 服务重启后生效。
        </p>
      ) : null}
      {!canEdit ? (
        <p className="subplatform-intro">
          商城运营可以查看状态；接入凭据仅由商城负责人修改。
        </p>
      ) : null}
    </section>
  );
}

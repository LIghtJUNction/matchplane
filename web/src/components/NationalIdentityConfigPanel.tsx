"use client";

import { useEffect, useState } from "react";
import { Save, ShieldCheck } from "lucide-react";
import { Input } from "@appica/ui-react/input";

import {
  getNationalIdentityConfig,
  saveNationalIdentityConfig,
  type NationalIdentityConfig,
} from "../api";
import { SectionHeading } from "./Primitives";

export function NationalIdentityConfigPanel({ rootRole, onNotice }: { rootRole?: string | null; onNotice: (message: string) => void }) {
  const canEdit = rootRole === "rootSuperAdmin";
  const [config, setConfig] = useState<NationalIdentityConfig | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [endpointMode, setEndpointMode] = useState<NationalIdentityConfig["endpointMode"]>("discovery");
  const [discoveryUrl, setDiscoveryUrl] = useState("");
  const [authorizationUrl, setAuthorizationUrl] = useState("");
  const [tokenUrl, setTokenUrl] = useState("");
  const [userInfoUrl, setUserInfoUrl] = useState("");
  const [scopes, setScopes] = useState("openid");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);

  useEffect(() => {
    let mounted = true;
    void getNationalIdentityConfig()
      .then((current) => { if (mounted && current) apply(current); })
      .catch((error) => { if (mounted) onNotice(error instanceof Error ? error.message : "国家网络身份认证配置读取失败"); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [onNotice]);

  const save = async () => {
    if (!canEdit) return;
    setSaving(true);
    try {
      const result = await saveNationalIdentityConfig({
        enabled,
        clientId,
        clientSecret: clientSecret || undefined,
        endpointMode,
        discoveryUrl: discoveryUrl || undefined,
        authorizationUrl: authorizationUrl || undefined,
        tokenUrl: tokenUrl || undefined,
        userInfoUrl: userInfoUrl || undefined,
        scopes: scopes.split(/[\s,]+/).map((scope) => scope.trim()).filter(Boolean),
      });
      apply(result.config);
      setClientSecret("");
      setRestartRequired(result.restartRequired);
      onNotice("国家网络身份认证配置已保存");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "国家网络身份认证配置保存失败");
    } finally {
      setSaving(false);
    }
  };

  function apply(current: NationalIdentityConfig) {
    setConfig(current);
    setEnabled(current.enabled);
    setClientId(current.clientId);
    setEndpointMode(current.endpointMode);
    setDiscoveryUrl(current.discoveryUrl);
    setAuthorizationUrl(current.authorizationUrl);
    setTokenUrl(current.tokenUrl);
    setUserInfoUrl(current.userInfoUrl);
    setScopes(current.scopes.join(", "));
  }

  return (
    <section className="surface national-identity-config" aria-labelledby="national-identity-title">
      <SectionHeading title="国家网络身份认证" titleId="national-identity-title" />
      <p className="subplatform-intro">接入已获授权的官方应用或授权网关。系统只保存稳定身份关联，不保存身份证号、网号或网证内容。</p>
      <div className="seller-upload-form">
        <label className="email-enabled seller-upload-wide"><input type="checkbox" checked={enabled} disabled={!canEdit || loading} onChange={(event) => setEnabled(event.target.checked)} />在登录页显示国家网络身份认证</label>
        <label htmlFor="national-identity-client-id"><span>Client ID</span><Input id="national-identity-client-id" value={clientId} disabled={!canEdit || loading} onChange={(event) => setClientId(event.target.value)} autoComplete="off" /></label>
        <label htmlFor="national-identity-client-secret"><span>Client Secret</span><Input id="national-identity-client-secret" type="password" value={clientSecret} disabled={!canEdit || loading} onChange={(event) => setClientSecret(event.target.value)} autoComplete="new-password" placeholder={config?.credentialConfigured ? "留空则保持当前密钥" : "填写官方分配的 Client Secret"} /></label>
        <label htmlFor="national-identity-endpoint-mode"><span>接入方式</span><select id="national-identity-endpoint-mode" value={endpointMode} disabled={!canEdit || loading} onChange={(event) => setEndpointMode(event.target.value as NationalIdentityConfig["endpointMode"])}><option value="discovery">OIDC discovery</option><option value="endpoints">授权网关 endpoint</option></select></label>
        <label htmlFor="national-identity-scopes"><span>Scopes</span><Input id="national-identity-scopes" value={scopes} disabled={!canEdit || loading} onChange={(event) => setScopes(event.target.value)} placeholder="openid" /></label>
        {endpointMode === "discovery" ? (
          <label className="seller-upload-wide" htmlFor="national-identity-discovery"><span>OIDC discovery 地址</span><Input id="national-identity-discovery" value={discoveryUrl} disabled={!canEdit || loading} onChange={(event) => setDiscoveryUrl(event.target.value)} placeholder="https://approved-gateway.example/.well-known/openid-configuration" inputMode="url" /></label>
        ) : (
          <div className="national-identity-endpoints seller-upload-wide">
            <label htmlFor="national-identity-authorize"><span>授权地址</span><Input id="national-identity-authorize" value={authorizationUrl} disabled={!canEdit || loading} onChange={(event) => setAuthorizationUrl(event.target.value)} inputMode="url" placeholder="https://approved-gateway.example/authorize" /></label>
            <label htmlFor="national-identity-token"><span>令牌地址</span><Input id="national-identity-token" value={tokenUrl} disabled={!canEdit || loading} onChange={(event) => setTokenUrl(event.target.value)} inputMode="url" placeholder="https://approved-gateway.example/token" /></label>
            <label htmlFor="national-identity-userinfo"><span>用户信息地址</span><Input id="national-identity-userinfo" value={userInfoUrl} disabled={!canEdit || loading} onChange={(event) => setUserInfoUrl(event.target.value)} inputMode="url" placeholder="https://approved-gateway.example/userinfo" /></label>
          </div>
        )}
        <div className="seller-upload-wide root-email-actions national-identity-actions">
          <p><ShieldCheck size={16} aria-hidden="true" />Client Secret：{config?.credentialConfigured ? "已就绪" : "尚未写入"}</p>
          {canEdit ? <button className="root-email-save" type="button" disabled={saving || loading} onClick={() => void save()}><Save size={16} aria-hidden="true" />{saving ? "保存中…" : "保存配置"}</button> : null}
        </div>
      </div>
      {restartRequired ? <p className="national-identity-restart" role="status">配置已保存。认证服务会在下一次 Web 服务重启后启用这个登录方式。</p> : null}
      {!canEdit ? <p className="subplatform-intro">商城运营可以查看状态；接入凭据仅由商城负责人修改。</p> : null}
    </section>
  );
}

"use client";

import { FormEvent, useEffect, useState } from "react";
import { Mail, Save, ShieldCheck } from "lucide-react";

import {
  getSubplatformEmailConfig,
  isLiveMarketplaceEnabled,
  saveSubplatformEmailConfig,
  type SubplatformEmailConfig,
  type SubplatformOrganizationRecord,
} from "../api";
import { getMarketplaceSession } from "../lib/marketplace-session";
import type { SubplatformConfig } from "../subplatform";
import { SectionHeading } from "./Primitives";
import { PlatformAccessPanel } from "./PlatformAccessPanel";
import { PlatformSiteSettingsPanel } from "./PlatformSiteSettingsPanel";

export function SubplatformAdminDashboard({
  onNotice,
  subplatform,
}: {
  onNotice: (message: string) => void;
  subplatform: SubplatformConfig;
}) {
  const [config, setConfig] = useState<SubplatformEmailConfig | null>(null);
  const [providerKey, setProviderKey] = useState("");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [tlsMode, setTlsMode] = useState<"starttls" | "tls" | "plain">("starttls");
  const [username, setUsername] = useState("");
  const [credentialSecretRef, setCredentialSecretRef] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [mode, setMode] = useState<"test" | "production">("test");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isLiveMarketplaceEnabled() || !subplatform.domainId) return;
    void getMarketplaceSession({
      subplatform: subplatform.slug,
      platformPath: subplatform.path,
      tenantId: subplatform.tenantId,
      domainId: subplatform.domainId,
      role: "subplatform_admin",
    }).then((session) => {
      if (!session) return null;
      return getSubplatformEmailConfig(session, subplatform.domainId!);
    })
      .then((current) => {
        if (!current) return;
        setConfig(current);
        setProviderKey(current.provider_key);
        setSmtpHost(current.smtp_host);
        setSmtpPort(String(current.smtp_port));
        setTlsMode(current.tls_mode as "starttls" | "tls" | "plain");
        setUsername(current.username);
        setFromAddress(current.from_address);
        setReplyTo(current.reply_to ?? "");
        setMode(current.mode as "test" | "production");
        setEnabled(current.enabled);
      })
      .catch(() => {
        // A missing config is a normal first-run state; the save form remains available.
      });
  }, [subplatform.domainId, subplatform.slug]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isLiveMarketplaceEnabled()) {
      onNotice("当前环境未启用真实子平台 API，邮箱配置没有写入系统");
      return;
    }
    const session = await getMarketplaceSession({
      subplatform: subplatform.slug,
      platformPath: subplatform.path,
      tenantId: subplatform.tenantId,
      domainId: subplatform.domainId,
      role: "subplatform_admin",
    });
    if (!session) {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/login?role=subplatform_admin&next=${encodeURIComponent(next)}`);
      return;
    }
    if (!subplatform.domainId) {
      onNotice("当前子平台尚未完成 domain 注册");
      return;
    }
    if (!providerKey.trim() || !smtpHost.trim() || !username.trim() || !credentialSecretRef.trim() || !fromAddress.trim()) {
      onNotice("请填写完整的邮件服务器配置；只提交 secret reference，不要填写明文密码");
      return;
    }
    setSaving(true);
    try {
      const updated = await saveSubplatformEmailConfig({
        session,
        domainId: subplatform.domainId,
        providerKey: providerKey.trim(),
        smtpHost: smtpHost.trim(),
        smtpPort: Number(smtpPort),
        tlsMode,
        username: username.trim(),
        credentialSecretRef: credentialSecretRef.trim(),
        fromAddress: fromAddress.trim(),
        replyTo: replyTo.trim() || undefined,
        mode,
        enabled,
        expectedVersion: config?.version,
        updatedBy: session.partyId,
      });
      setConfig(updated);
      onNotice("子平台邮箱配置已保存");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "邮箱配置保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="dashboard subplatform-admin-dashboard">
      <section className="workspace-heading">
        <div>
          <p className="eyebrow">子平台管理员 · {subplatform.label || subplatform.brandName}</p>
          <h1>管理本子平台的登录与通知邮箱。</h1>
          <p>SMTP 配置只作用于当前路径。根平台保留账号、权限和审计；密钥由服务器 secret manager 解析。</p>
        </div>
        <span className="seller-mode-note"><ShieldCheck size={16} aria-hidden="true" /> 仅当前子平台作用域</span>
      </section>

      <section className="surface seller-upload" aria-labelledby="email-config-title">
        <SectionHeading eyebrow="邮箱服务器" title="配置登录邮件与通知发送方" />
        <form className="seller-upload-form" onSubmit={save}>
          <label htmlFor="email-provider-key"><span>Provider key</span><input id="email-provider-key" value={providerKey} onChange={(event) => setProviderKey(event.target.value)} placeholder="子平台自己的标识" /></label>
          <label htmlFor="email-smtp-host"><span>SMTP 主机</span><input id="email-smtp-host" value={smtpHost} onChange={(event) => setSmtpHost(event.target.value)} placeholder="smtp.example.com" /></label>
          <label htmlFor="email-smtp-port"><span>端口</span><input id="email-smtp-port" value={smtpPort} onChange={(event) => setSmtpPort(event.target.value)} inputMode="numeric" /></label>
          <label htmlFor="email-tls-mode"><span>TLS 模式</span><select id="email-tls-mode" value={tlsMode} onChange={(event) => setTlsMode(event.target.value as "starttls" | "tls" | "plain")}><option value="starttls">STARTTLS</option><option value="tls">TLS</option><option value="plain">明文（仅受控内网）</option></select></label>
          <label htmlFor="email-username"><span>SMTP 用户名</span><input id="email-username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label>
          <label htmlFor="email-secret-ref"><span>Secret reference（不填密码）</span><input id="email-secret-ref" value={credentialSecretRef} onChange={(event) => setCredentialSecretRef(event.target.value)} placeholder="secret://subplatform/&lt;tenant&gt;/&lt;domain&gt;/smtp-password" /></label>
          <label htmlFor="email-from"><span>发件人地址</span><input id="email-from" type="email" value={fromAddress} onChange={(event) => setFromAddress(event.target.value)} /></label>
          <label htmlFor="email-reply-to"><span>回复地址（可选）</span><input id="email-reply-to" type="email" value={replyTo} onChange={(event) => setReplyTo(event.target.value)} /></label>
          <label htmlFor="email-mode"><span>发送模式</span><select id="email-mode" value={mode} onChange={(event) => setMode(event.target.value as "test" | "production")}><option value="test">测试</option><option value="production">生产</option></select></label>
          <label className="email-enabled"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />启用当前邮箱路由</label>
          <div className="seller-upload-actions seller-upload-wide"><p><Mail size={17} aria-hidden="true" /> {config?.credential_configured ? "服务器密钥已配置" : "尚未配置服务器密钥"}</p><button className="button button-dark" type="submit" disabled={saving}><Save size={17} aria-hidden="true" />{saving ? "保存中…" : "保存邮箱配置"}</button></div>
        </form>
      </section>
      <PlatformSiteSettingsPanel
        organizationId={subplatform.organizationId}
        platformPath={subplatform.path}
        platformName={subplatform.brandName}
        onNotice={onNotice}
      />
      <PlatformAccessPanel
        organizations={subplatform.organizationId ? [scopedOrganization(subplatform)] : []}
        rootRole="subplatform_admin"
        onNotice={onNotice}
      />
    </div>
  );
}

function scopedOrganization(subplatform: SubplatformConfig): SubplatformOrganizationRecord {
  return {
    id: subplatform.organizationId!,
    name: subplatform.brandName,
    slug: subplatform.slug,
    parentOrganizationId: null,
    tenantId: subplatform.tenantId ?? "",
    domainId: subplatform.domainId ?? "",
    sourceRepository: null,
    createdAt: "",
    registrationId: null,
    registrationState: "active",
    buildDigest: null,
    manifestDigest: null,
  };
}

"use client";

import { FormEvent, useEffect, useState } from "react";
import { MailCheck, Save, Send, ShieldCheck } from "lucide-react";
import { Input } from "@appica/ui-react/input";

import {
  getRootEmailConfig,
  saveRootEmailConfig,
  testRootEmailConfig,
  type RootEmailConfig,
} from "../api";
import { SectionHeading } from "./Primitives";

export function RootEmailConfigPanel({
  rootRole,
  onNotice,
}: {
  rootRole?: string | null;
  onNotice: (message: string) => void;
}) {
  const canEdit = rootRole === "rootSuperAdmin";
  const [config, setConfig] = useState<RootEmailConfig | null>(null);
  const [providerKey, setProviderKey] = useState("root-smtp");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [tlsMode, setTlsMode] = useState<RootEmailConfig["tlsMode"]>("starttls");
  const [username, setUsername] = useState("");
  const [credentialSlot, setCredentialSlot] = useState("smtp-password");
  const [fromAddress, setFromAddress] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [mode, setMode] = useState<RootEmailConfig["mode"]>("production");
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    let mounted = true;
    void getRootEmailConfig()
      .then((current) => {
        if (!mounted || !current) return;
        applyConfig(current);
      })
      .catch((error) => {
        if (mounted) onNotice(error instanceof Error ? error.message : "根邮箱配置读取失败");
      })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [onNotice]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canEdit) return;
    setSaving(true);
    try {
      const updated = await saveRootEmailConfig({
        providerKey: providerKey.trim(),
        smtpHost: smtpHost.trim(),
        smtpPort: Number(smtpPort),
        tlsMode,
        username: username.trim(),
        credentialSlot: credentialSlot.trim(),
        fromAddress: fromAddress.trim(),
        replyTo: replyTo.trim() || null,
        mode,
        enabled,
        expectedVersion: config?.version,
      });
      applyConfig(updated);
      onNotice(updated.credentialConfigured ? "根邮箱配置已保存，可发送测试邮件" : "根邮箱配置已保存；请先写入密钥槽后再测试");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "根邮箱配置保存失败");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      await testRootEmailConfig();
      onNotice("测试邮件已发送到当前超级管理员的已验证邮箱");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "测试邮件发送失败");
    } finally {
      setTesting(false);
    }
  };

  function applyConfig(current: RootEmailConfig) {
    setConfig(current);
    setProviderKey(current.providerKey);
    setSmtpHost(current.smtpHost);
    setSmtpPort(String(current.smtpPort));
    setTlsMode(current.tlsMode);
    setUsername(current.username);
    setCredentialSlot(current.credentialSlot);
    setFromAddress(current.fromAddress);
    setReplyTo(current.replyTo ?? "");
    setMode(current.mode);
    setEnabled(current.enabled);
  }

  const secretCommand = `sudo matchplane secret put --slot ${credentialSlot || "smtp-password"}`;
  return (
    <section className="surface root-email-config" aria-labelledby="root-email-config-title">
      <SectionHeading eyebrow="根邮箱" title="配置登录、验证与密码重置邮件" titleId="root-email-config-title" />
      <p className="subplatform-intro">这是全站账号邮件通道，不属于任何卖方或子平台。密码不进浏览器或数据库；只需在服务器执行一次安全命令写入密钥槽。</p>
      <form className="seller-upload-form" onSubmit={save}>
        <label htmlFor="root-email-provider"><span>Provider key</span><Input id="root-email-provider" value={providerKey} disabled={!canEdit || loading} onChange={(event) => setProviderKey(event.target.value)} placeholder="root-smtp" /></label>
        <label htmlFor="root-email-host"><span>SMTP 主机</span><Input id="root-email-host" value={smtpHost} disabled={!canEdit || loading} onChange={(event) => setSmtpHost(event.target.value)} placeholder="smtp.example.com" /></label>
        <label htmlFor="root-email-port"><span>端口</span><Input id="root-email-port" value={smtpPort} disabled={!canEdit || loading} onChange={(event) => setSmtpPort(event.target.value)} inputMode="numeric" /></label>
        <label htmlFor="root-email-tls"><span>TLS 模式</span><select id="root-email-tls" value={tlsMode} disabled={!canEdit || loading} onChange={(event) => setTlsMode(event.target.value as RootEmailConfig["tlsMode"])}><option value="starttls">STARTTLS</option><option value="tls">TLS</option><option value="plain">明文（仅受控内网）</option></select></label>
        <label htmlFor="root-email-user"><span>SMTP 用户名</span><Input id="root-email-user" value={username} disabled={!canEdit || loading} onChange={(event) => setUsername(event.target.value)} autoComplete="username" /></label>
        <label htmlFor="root-email-slot"><span>密钥槽</span><Input id="root-email-slot" value={credentialSlot} disabled={!canEdit || loading} onChange={(event) => setCredentialSlot(event.target.value)} placeholder="smtp-password" /></label>
        <label htmlFor="root-email-from"><span>发件人地址</span><Input id="root-email-from" type="email" value={fromAddress} disabled={!canEdit || loading} onChange={(event) => setFromAddress(event.target.value)} /></label>
        <label htmlFor="root-email-reply"><span>回复地址（可选）</span><Input id="root-email-reply" type="email" value={replyTo} disabled={!canEdit || loading} onChange={(event) => setReplyTo(event.target.value)} /></label>
        <label htmlFor="root-email-mode"><span>发送模式</span><select id="root-email-mode" value={mode} disabled={!canEdit || loading} onChange={(event) => setMode(event.target.value as RootEmailConfig["mode"])}><option value="production">生产</option><option value="test">测试</option></select></label>
        <label className="email-enabled"><input type="checkbox" checked={enabled} disabled={!canEdit || loading} onChange={(event) => setEnabled(event.target.checked)} />启用根邮箱路由</label>
        <div className="seller-upload-wide root-email-actions">
          <p><ShieldCheck size={16} aria-hidden="true" />密钥槽：{config?.credentialConfigured ? "已就绪" : "尚未写入"}</p>
          <div className="root-email-action-buttons">
            {canEdit ? <button className="root-email-save" type="submit" disabled={saving || loading}><Save size={16} aria-hidden="true" />{saving ? "保存中…" : "保存配置"}</button> : null}
            <button className="root-email-test" type="button" disabled={!canEdit || testing || !config?.credentialConfigured || !config.enabled} onClick={() => void test()}><Send size={16} aria-hidden="true" />{testing ? "发送中…" : "发送测试"}</button>
          </div>
        </div>
      </form>
      {canEdit ? <div className="root-email-secret-step"><MailCheck size={18} aria-hidden="true" /><div><strong>写入密钥后即可生效</strong><code>{secretCommand}</code><small>命令会隐藏输入内容，原子写入服务器受保护目录；无需编辑环境变量或重启服务。</small></div></div> : <p className="subplatform-intro">根管理员可以查看状态；保存配置和发送测试邮件只由超级管理员执行。</p>}
    </section>
  );
}

"use client";

import { useEffect, useState } from "react";
import { Save, Send, ShieldCheck } from "lucide-react";
import { Input } from "@appica/ui-react/input";

import {
  getSmsGatewayConfig,
  saveSmsGatewayConfig,
  testSmsGatewayConfig,
  type SmsGatewayConfig,
} from "../api";
import { SectionHeading } from "./Primitives";

export function PhoneLoginConfigPanel({ rootRole, onNotice }: { rootRole?: string | null; onNotice: (message: string) => void }) {
  const canEdit = rootRole === "rootSuperAdmin";
  const [config, setConfig] = useState<SmsGatewayConfig | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [token, setToken] = useState("");
  const [testPhoneNumber, setTestPhoneNumber] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    let mounted = true;
    void getSmsGatewayConfig()
      .then((current) => { if (mounted && current) apply(current); })
      .catch((error) => { if (mounted) onNotice(error instanceof Error ? error.message : "短信网关配置读取失败"); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [onNotice]);

  const save = async () => {
    if (!canEdit) return;
    setSaving(true);
    try {
      const result = await saveSmsGatewayConfig({
        enabled,
        gatewayUrl,
        token: token || undefined,
      });
      apply(result);
      setToken("");
      onNotice("短信网关配置已保存，立即生效");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "短信网关配置保存失败");
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!canEdit) return;
    setTesting(true);
    try {
      await testSmsGatewayConfig(testPhoneNumber.trim());
      onNotice("测试验证码已交给短信网关发送");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "测试短信发送失败");
    } finally {
      setTesting(false);
    }
  };

  function apply(current: SmsGatewayConfig) {
    setConfig(current);
    setEnabled(current.enabled);
    setGatewayUrl(current.gatewayUrl);
  }

  return (
    <section className="surface phone-login-config" aria-labelledby="phone-login-config-title">
      <SectionHeading eyebrow="手机号登录" title="配置验证码短信网关" titleId="phone-login-config-title" />
      <p className="subplatform-intro">验证码由认证服务生成，商城只把它交给你自己运营的短信网关。生产环境必须使用 HTTPS 网关；本地演示可以填 http://localhost 的 mock 网关。</p>
      <div className="seller-upload-form">
        <label className="email-enabled seller-upload-wide"><input type="checkbox" checked={enabled} disabled={!canEdit || loading} onChange={(event) => setEnabled(event.target.checked)} />在登录页显示手机号验证码登录</label>
        <label className="seller-upload-wide" htmlFor="sms-gateway-url"><span>网关地址</span><Input id="sms-gateway-url" value={gatewayUrl} disabled={!canEdit || loading} onChange={(event) => setGatewayUrl(event.target.value)} inputMode="url" placeholder="https://sms-gateway.example/send" /></label>
        <label className="seller-upload-wide" htmlFor="sms-gateway-token"><span>访问令牌（可选）</span><Input id="sms-gateway-token" type="password" value={token} disabled={!canEdit || loading} onChange={(event) => setToken(event.target.value)} autoComplete="new-password" placeholder={config?.tokenConfigured ? "留空则保持当前令牌" : "网关要求 Bearer 令牌时填写"} /></label>
        <div className="seller-upload-wide root-email-actions phone-login-actions">
          <p><ShieldCheck size={16} aria-hidden="true" />访问令牌：{config?.tokenConfigured ? "已就绪" : "尚未写入"}</p>
          {canEdit ? <button className="root-email-save" type="button" disabled={saving || loading} onClick={() => void save()}><Save size={16} aria-hidden="true" />{saving ? "保存中…" : "保存配置"}</button> : null}
        </div>
        <label className="seller-upload-wide" htmlFor="sms-gateway-test-phone"><span>测试手机号（E.164）</span><Input id="sms-gateway-test-phone" value={testPhoneNumber} disabled={!canEdit || loading} onChange={(event) => setTestPhoneNumber(event.target.value)} inputMode="tel" placeholder="+8613800000000" /></label>
        <div className="seller-upload-wide root-email-actions phone-login-actions">
          <p>发送一条固定内容的测试验证码，确认网关可达。</p>
          <button className="root-email-test" type="button" disabled={!canEdit || testing || loading || !testPhoneNumber.trim()} onClick={() => void test()}><Send size={16} aria-hidden="true" />{testing ? "发送中…" : "发送测试"}</button>
        </div>
      </div>
      {!canEdit ? <p className="subplatform-intro">商城运营可以查看状态；网关地址、令牌和测试发送仅由商城负责人执行。</p> : null}
    </section>
  );
}

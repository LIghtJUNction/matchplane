"use client";

import { useEffect, useState } from "react";
import { Bot, Save, Send, ShieldCheck } from "lucide-react";
import { Input } from "@appica/ui-react/input";

import {
  getManagedPlatformRouterConfig,
  listManagedPlatformRouterModels,
  saveManagedPlatformRouterConfig,
  testPlatformAi,
  type ManagedPlatformRouterConfig,
} from "../api";
import { SectionHeading } from "./Primitives";

export function PlatformAiConfigPanel({ rootRole, onNotice }: { rootRole?: string | null; onNotice: (message: string) => void }) {
  const canEdit = rootRole === "rootSuperAdmin";
  const [config, setConfig] = useState<ManagedPlatformRouterConfig | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [protocol, setProtocol] = useState<ManagedPlatformRouterConfig["protocol"]>("openai-compatible");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    let mounted = true;
    void getManagedPlatformRouterConfig()
      .then((current) => { if (mounted && current) apply(current); })
      .catch((error) => { if (mounted) onNotice(error instanceof Error ? error.message : "AI 配置读取失败"); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [onNotice]);

  const save = async () => {
    if (!canEdit) return;
    setSaving(true);
    try {
      const updated = await saveManagedPlatformRouterConfig({ endpoint, model, protocol, enabled, apiKey: apiKey || undefined });
      apply(updated);
      setApiKey("");
      onNotice(updated.credentialConfigured ? "AI 配置已保存" : "请输入 API Key 后再保存");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "AI 配置保存失败");
    } finally { setSaving(false); }
  };

  const test = async () => {
    setTesting(true);
    try { await testPlatformAi(); onNotice("AI 连接测试成功"); }
    catch (error) { onNotice(error instanceof Error ? error.message : "AI 连接测试失败"); }
    finally { setTesting(false); }
  };

  const loadModels = async () => {
    setModelsLoading(true);
    try {
      const loaded = await listManagedPlatformRouterModels({ endpoint, protocol, apiKey: apiKey || undefined });
      setModels(loaded);
      if (!loaded.includes(model)) setModel(loaded[0] ?? "");
      onNotice(`已获取 ${loaded.length} 个模型`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "模型列表读取失败");
    } finally { setModelsLoading(false); }
  };

  function apply(current: ManagedPlatformRouterConfig) {
    setConfig(current); setEndpoint(current.endpoint); setModel(current.model); setModels([current.model]); setProtocol(current.protocol); setEnabled(current.enabled);
  }

  return (
    <section className="surface root-email-config platform-ai-config" aria-labelledby="platform-ai-config-title">
      <SectionHeading eyebrow="平台 AI" title="配置平台路由模型" titleId="platform-ai-config-title" />
      <p className="subplatform-intro">用于选择已嵌入的子平台。API Key 只写入服务器受保护存储，不会显示或保存到数据库。</p>
      <div className="seller-upload-form">
        <label htmlFor="platform-ai-endpoint"><span>模型网关主机</span><Input id="platform-ai-endpoint" value={endpoint} disabled={!canEdit || loading} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://api.example.com" inputMode="url" /></label>
        <label htmlFor="platform-ai-protocol"><span>协议</span><select id="platform-ai-protocol" value={protocol} disabled={!canEdit || loading} onChange={(event) => setProtocol(event.target.value as ManagedPlatformRouterConfig["protocol"])}><option value="openai-compatible">OpenAI Compatible</option><option value="anthropic-messages">Anthropic Messages</option><option value="gemini-generate-content">Gemini Generate Content</option></select></label>
        <label htmlFor="platform-ai-key"><span>API Key</span><Input id="platform-ai-key" type="password" value={apiKey} disabled={!canEdit || loading} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" placeholder={config?.credentialConfigured ? "留空则保持当前 API Key" : "填写 API Key"} /></label>
        <div className="platform-ai-model-picker seller-upload-wide"><button className="root-email-test" type="button" disabled={!canEdit || modelsLoading || loading} onClick={() => void loadModels()}>{modelsLoading ? "获取中…" : "获取模型列表"}</button><label htmlFor="platform-ai-model"><span>模型</span><select id="platform-ai-model" value={model} disabled={!canEdit || loading || !models.length} onChange={(event) => setModel(event.target.value)}><option value="">选择模型</option>{models.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}</select></label></div>
        <label className="email-enabled"><input type="checkbox" checked={enabled} disabled={!canEdit || loading} onChange={(event) => setEnabled(event.target.checked)} />启用平台 AI 路由</label>
        <div className="seller-upload-wide root-email-actions">
          <p><ShieldCheck size={16} aria-hidden="true" />API Key：{config?.credentialConfigured ? "已就绪" : "尚未写入"}</p>
          <div className="root-email-action-buttons">
            {canEdit ? <button className="root-email-save" type="button" disabled={saving || loading} onClick={() => void save()}><Save size={16} aria-hidden="true" />{saving ? "保存中…" : "保存配置"}</button> : null}
            <button className="root-email-test" type="button" disabled={!canEdit || testing || !config?.credentialConfigured || !config.enabled} onClick={() => void test()}><Send size={16} aria-hidden="true" />{testing ? "测试中…" : "测试连接"}</button>
          </div>
        </div>
      </div>
      {!canEdit ? <p className="subplatform-intro"><Bot size={15} aria-hidden="true" />根管理员可以查看状态；保存和测试仅由超级管理员执行。</p> : null}
    </section>
  );
}

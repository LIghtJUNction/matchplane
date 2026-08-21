"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Clipboard, Globe2, Radio, RefreshCw, XCircle } from "lucide-react";

import {
  activateFederationBinding,
  createFederationInvite,
  getFederationBindings,
  probeFederationBinding,
  revokeFederationBinding,
  type FederationBindingRecord,
  type PlatformDomainRecord,
} from "../api";

export function RemoteStoreOnboarding({ domains, onNotice }: { domains: PlatformDomainRecord[]; onNotice: (message: string) => void }) {
  const [domainId, setDomainId] = useState("");
  const [expiresHours, setExpiresHours] = useState("24");
  const [bindings, setBindings] = useState<FederationBindingRecord[]>([]);
  const [tokenEnv, setTokenEnv] = useState<Record<string, string>>({});
  const [invite, setInvite] = useState<{ token: string; url: string; expiresAt: string } | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = async () => setBindings(await getFederationBindings());

  useEffect(() => {
    setDomainId((current) => current || domains.find((domain) => domain.status === "active")?.id || "");
  }, [domains]);

  useEffect(() => {
    let mounted = true;
    void getFederationBindings()
      .then((items) => { if (mounted) setBindings(items); })
      .catch((error) => { if (mounted) onNotice(error instanceof Error ? error.message : "在线店铺读取失败"); });
    return () => { mounted = false; };
  }, [onNotice]);

  const createInvite = async () => {
    if (!domainId) {
      onNotice("请先选择商品范围");
      return;
    }
    setLoading(true);
    try {
      const created = await createFederationInvite({
        domainId,
        expiresInHours: Math.max(1, Math.min(168, Number.parseInt(expiresHours, 10) || 24)),
      });
      setInvite({ token: created.enrollmentToken, url: created.enrollmentUrl, expiresAt: created.expiresAt });
      await refresh();
      onNotice("在线店铺接入凭据已生成");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "在线店铺接入失败");
    } finally {
      setLoading(false);
    }
  };

  const activate = async (binding: FederationBindingRecord) => {
    setLoading(true);
    try {
      await activateFederationBinding({
        bindingId: binding.id,
        tokenEnv: tokenEnv[binding.id]?.trim() || defaultTokenEnv(binding.slug),
        membershipPolicy: "public",
      });
      await refresh();
      onNotice(`${binding.displayName} 已上线`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "在线店铺上线失败");
    } finally {
      setLoading(false);
    }
  };

  const probe = async (binding: FederationBindingRecord) => {
    setLoading(true);
    try {
      const result = await probeFederationBinding(binding.id);
      await refresh();
      onNotice(result.status === "active" ? `${binding.displayName} 连接正常` : `${binding.displayName} 暂时不可用`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "在线店铺检查失败");
    } finally {
      setLoading(false);
    }
  };

  const revoke = async (binding: FederationBindingRecord) => {
    setLoading(true);
    try {
      await revokeFederationBinding(binding.id);
      await refresh();
      onNotice(`${binding.displayName} 已停止接入`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "在线店铺停止失败");
    } finally {
      setLoading(false);
    }
  };

  const copyInvite = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard?.writeText(invite.token);
      onNotice("接入凭据已复制");
    } catch {
      onNotice("浏览器未授予复制权限，请手动复制接入凭据");
    }
  };

  return (
    <section className="surface remote-store-panel" aria-labelledby="remote-store-title">
      <div className="subplatform-header">
        <div>
          <h2 id="remote-store-title">在线店铺</h2>
          <p className="subplatform-intro">店铺部署在其他服务器时，在这里接入。远程服务使用一次性接入凭据提交自己的地址和已签名店铺资料；商城不会要求你把 API Key 写进浏览器。</p>
        </div>
      </div>
      <div className="remote-store-form">
        <label><span>商品范围</span><select value={domainId} onChange={(event) => setDomainId(event.target.value)}>{domains.filter((domain) => domain.status === "active").map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}</select></label>
        <label><span>接入凭据有效期</span><input type="number" min={1} max={168} value={expiresHours} onChange={(event) => setExpiresHours(event.target.value)} /><small>小时</small></label>
        <button className="button button-dark" type="button" disabled={loading || !domainId} onClick={() => void createInvite()}><Globe2 size={16} aria-hidden="true" />生成接入凭据</button>
      </div>
      {invite ? <div className="remote-store-token"><div><strong>交给远程店铺服务</strong><small>接入地址</small><code>{invite.url}</code><small>一次性接入凭据 · 到期 {new Date(invite.expiresAt).toLocaleString()}</small><code>{invite.token}</code></div><button type="button" onClick={() => void copyInvite()}><Clipboard size={15} aria-hidden="true" />复制</button><button type="button" onClick={() => setInvite(null)}>关闭</button></div> : null}
      <div className="remote-store-list" aria-label="在线店铺列表">
        {bindings.length ? bindings.map((binding) => (
          <div className="remote-store-row" key={binding.id}>
            <span className="remote-store-icon">{binding.status === "active" ? <CheckCircle2 size={18} aria-hidden="true" /> : binding.status === "degraded" ? <XCircle size={18} aria-hidden="true" /> : <Radio size={18} aria-hidden="true" />}</span>
            <span><strong>{binding.displayName}</strong><small>{binding.endpoint}</small></span>
            {binding.status === "pending" ? <><input aria-label={`${binding.displayName} 的远程 API Key 环境变量`} value={tokenEnv[binding.id] ?? defaultTokenEnv(binding.slug)} onChange={(event) => setTokenEnv((current) => ({ ...current, [binding.id]: event.target.value }))} /><button type="button" disabled={loading} onClick={() => void activate(binding)}>上线</button></> : binding.status === "revoked" ? <small>已停止</small> : <><button type="button" disabled={loading} onClick={() => void probe(binding)}><RefreshCw size={14} aria-hidden="true" />检查</button><button type="button" disabled={loading} onClick={() => void revoke(binding)}>停止</button></>}
          </div>
        )) : <p className="platform-access-empty">还没有在线店铺。</p>}
      </div>
    </section>
  );
}

function defaultTokenEnv(slug: string): string {
  const key = slug.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toUpperCase() || "REMOTE";
  return `MATCHPLANE_${key}_MCP_TOKEN`;
}

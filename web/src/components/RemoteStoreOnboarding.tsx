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
  const [expiresHours, setExpiresHours] = useState("168");
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
      .catch((error) => { if (mounted) onNotice(error instanceof Error ? error.message : "远程店铺读取失败"); });
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
        expiresInHours: Math.max(1, Math.min(168, Number.parseInt(expiresHours, 10) || 168)),
      });
      setInvite({ token: created.enrollmentToken, url: created.enrollmentUrl, expiresAt: created.expiresAt });
      await refresh();
      onNotice("一次性连接链接已生成；店铺接入后不会随链接到期");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "远程店铺接入失败");
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
      onNotice(error instanceof Error ? error.message : "远程店铺接入确认失败");
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
      onNotice(error instanceof Error ? error.message : "远程店铺连接检查失败");
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
      onNotice(error instanceof Error ? error.message : "远程店铺断开失败");
    } finally {
      setLoading(false);
    }
  };

  const copyInvite = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard?.writeText(invite.token);
      onNotice("一次性连接凭据已复制");
    } catch {
      onNotice("浏览器未授予复制权限，请手动复制连接凭据");
    }
  };

  return (
    <section className="surface remote-store-panel" aria-labelledby="remote-store-title">
      <div className="subplatform-header remote-store-heading">
        <div>
          <h2 id="remote-store-title">远程店铺接入</h2>
          <p className="subplatform-intro">连接运行在其他服务器上的店铺。一次性连接链接只用于首次握手；接入成功后店铺会持续保留，不需要按小时续期。</p>
        </div>
      </div>
      <div className="remote-store-explanation">
        <strong>连接链接有时效，店铺没有。</strong>
        <span>远程服务在有效期内使用一次即可；之后只需关注连接状态和同步健康。</span>
      </div>
      {domainId ? <div className="remote-store-form">
        <label><span>一次性连接链接有效期</span><select value={expiresHours} onChange={(event) => setExpiresHours(event.target.value)}><option value="24">24 小时</option><option value="72">3 天</option><option value="168">7 天（推荐）</option></select></label>
        <button className="button button-dark" type="button" disabled={loading} onClick={() => void createInvite()}><Globe2 size={16} aria-hidden="true" />生成一次性连接链接</button>
      </div> : <p className="platform-access-empty" role="status">商城数据尚未初始化，暂时不能接入远程店铺。</p>}
      {invite ? <div className="remote-store-token"><div><strong>一次性连接信息</strong><small>远程服务提交地址</small><code>{invite.url}</code><small>凭据将在 {new Date(invite.expiresAt).toLocaleString()} 失效；已接入店铺不受影响</small><code>{invite.token}</code></div><button type="button" onClick={() => void copyInvite()}><Clipboard size={15} aria-hidden="true" />复制凭据</button><button type="button" onClick={() => setInvite(null)}>关闭</button></div> : null}
      <div className="remote-store-list-heading"><div><strong>已接入的远程店铺</strong><small>持久连接；可随时检查或主动断开</small></div><span>{bindings.length} 家</span></div>
      <div className="remote-store-list" aria-label="已接入的远程店铺">
        {bindings.length ? bindings.map((binding) => (
          <div className="remote-store-row" key={binding.id}>
            <span className="remote-store-icon">{binding.status === "active" ? <CheckCircle2 size={18} aria-hidden="true" /> : binding.status === "degraded" ? <XCircle size={18} aria-hidden="true" /> : <Radio size={18} aria-hidden="true" />}</span>
            <span className="remote-store-copy"><strong>{binding.displayName}</strong><small className="remote-store-endpoint">{binding.endpoint}</small><small>{bindingStatusLabel(binding)}{binding.lastHealthAt ? " · 最近检查 " + new Date(binding.lastHealthAt).toLocaleString() : ""}</small></span>
            {binding.status === "pending" ? <div className="remote-store-activation"><label><span>服务端密钥变量</span><input aria-label={binding.displayName + " 的服务端密钥变量"} value={tokenEnv[binding.id] ?? defaultTokenEnv(binding.slug)} onChange={(event) => setTokenEnv((current) => ({ ...current, [binding.id]: event.target.value }))} /></label><button type="button" disabled={loading} onClick={() => void activate(binding)}>确认接入</button></div> : binding.status === "revoked" ? <small>已断开</small> : <div className="remote-store-actions"><button type="button" disabled={loading} onClick={() => void probe(binding)}><RefreshCw size={14} aria-hidden="true" />检查连接</button><button type="button" disabled={loading} onClick={() => void revoke(binding)}>断开</button></div>}
          </div>
        )) : <p className="platform-access-empty">还没有接入远程店铺。</p>}
      </div>
    </section>
  );
}

function bindingStatusLabel(binding: FederationBindingRecord): string {
  if (binding.status === "active") return "连接正常";
  if (binding.status === "degraded") return binding.lastError ? "连接异常：" + binding.lastError : "连接异常";
  if (binding.status === "pending") return "等待远程服务完成连接";
  if (binding.status === "revoked") return "已断开";
  return binding.status;
}

function defaultTokenEnv(slug: string): string {
  const key = slug.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toUpperCase() || "REMOTE";
  return `MATCHPLANE_${key}_MCP_TOKEN`;
}

"use client";

import { Button } from "@appica/ui-react/button";
import {
  CheckCircle2,
  Clipboard,
  Globe2,
  Radio,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  activateFederationBinding,
  createFederationInvite,
  getFederationBindings,
  probeFederationBinding,
  revokeFederationBinding,
  type FederationBindingRecord,
} from "../api";
import type { PlatformDomainsResourceState } from "../hooks/usePlatformBootstrapResources";
import { bootstrapResourceData } from "../hooks/usePlatformBootstrapResources";

export function RemoteStoreOnboarding({
  domainsResource,
  onNotice,
}: {
  domainsResource: PlatformDomainsResourceState;
  onNotice: (message: string) => void;
}) {
  const [domainId, setDomainId] = useState("");
  const [expiresHours, setExpiresHours] = useState("168");
  const [bindings, setBindings] = useState<FederationBindingRecord[]>([]);
  const [tokenEnv, setTokenEnv] = useState<Record<string, string>>({});
  const [invite, setInvite] = useState<{
    token: string;
    url: string;
    expiresAt: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [bindingsStatus, setBindingsStatus] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [bindingsError, setBindingsError] = useState<string | null>(null);
  const observedFreshDomainsRef = useRef(false);
  const bindingsRequestRef = useRef(0);
  const mountedRef = useRef(true);
  const freshDomains =
    domainsResource.status === "ready" ? domainsResource.data : null;
  const activeDomains = useMemo(
    () => freshDomains?.filter((domain) => domain.status === "active") ?? [],
    [freshDomains],
  );
  const previousDomains = bootstrapResourceData(domainsResource);

  const refresh = useCallback(async () => {
    const requestId = ++bindingsRequestRef.current;
    setBindingsStatus("loading");
    setBindingsError(null);
    try {
      const items = await getFederationBindings();
      if (mountedRef.current && requestId === bindingsRequestRef.current) {
        setBindings(items);
        setBindingsStatus("ready");
      }
      return items;
    } catch (error) {
      if (mountedRef.current && requestId === bindingsRequestRef.current) {
        setBindingsStatus("error");
        setBindingsError(
          error instanceof Error ? error.message : "远程店铺读取失败",
        );
      }
      throw error;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      bindingsRequestRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!freshDomains) return;
    const firstFreshResult = !observedFreshDomainsRef.current;
    observedFreshDomainsRef.current = true;
    setDomainId((current) => {
      if (current && !activeDomains.some((domain) => domain.id === current))
        return "";
      if (!current && firstFreshResult && activeDomains.length === 1)
        return activeDomains[0]?.id ?? "";
      return current;
    });
  }, [activeDomains, freshDomains]);

  useEffect(() => {
    void refresh().catch((error) => {
      if (mountedRef.current)
        onNotice(error instanceof Error ? error.message : "远程店铺读取失败");
    });
  }, [onNotice, refresh]);

  const createInvite = async () => {
    if (domainsResource.status !== "ready") {
      onNotice("商城数据范围尚未验证，请重新读取后再接入远程店铺");
      return;
    }
    const selectedDomain = activeDomains.find(
      (domain) => domain.id === domainId,
    );
    if (!selectedDomain) {
      onNotice("请选择一个已验证的商城数据范围");
      return;
    }
    setLoading(true);
    try {
      const created = await createFederationInvite({
        domainId: selectedDomain.id,
        expiresInHours: Math.max(
          1,
          Math.min(168, Number.parseInt(expiresHours, 10) || 168),
        ),
      });
      setInvite({
        token: created.enrollmentToken,
        url: created.enrollmentUrl,
        expiresAt: created.expiresAt,
      });
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
      onNotice(
        result.status === "active"
          ? `${binding.displayName} 连接正常`
          : `${binding.displayName} 暂时不可用`,
      );
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
    <section
      className="surface remote-store-panel"
      aria-labelledby="remote-store-title"
    >
      <div className="subplatform-header remote-store-heading">
        <div>
          <h2 id="remote-store-title">远程店铺接入</h2>
          <p className="subplatform-intro">
            连接运行在其他服务器上的店铺。一次性连接链接只用于首次握手；接入成功后店铺会持续保留，不需要按小时续期。
          </p>
        </div>
      </div>
      <div className="remote-store-explanation">
        <strong>连接链接有时效，店铺没有。</strong>
        <span>
          远程服务在有效期内使用一次即可；之后只需关注连接状态和同步健康。
        </span>
      </div>
      {domainsResource.status === "ready" ? (
        activeDomains.length ? (
          <div className="remote-store-form">
            <label>
              <span>商城数据范围</span>
              <select
                required
                value={domainId}
                onChange={(event) => setDomainId(event.target.value)}
              >
                <option value="">明确选择数据范围</option>
                {activeDomains.map((domain) => (
                  <option key={domain.id} value={domain.id}>
                    {domain.name} · /{domain.slug}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>一次性连接链接有效期</span>
              <select
                value={expiresHours}
                onChange={(event) => setExpiresHours(event.target.value)}
              >
                <option value="24">24 小时</option>
                <option value="72">3 天</option>
                <option value="168">7 天（推荐）</option>
              </select>
            </label>
            <Button
              variant="primary"
              size="md"
              className="min-h-11 w-full justify-center sm:w-auto"
              type="button"
              disabled={loading || !domainId}
              onClick={() => void createInvite()}
            >
              <Globe2 size={16} aria-hidden="true" />
              生成一次性连接链接
            </Button>
          </div>
        ) : (
          <p className="platform-access-empty" role="status">
            商城数据范围已确认为空，暂时不能接入远程店铺。
          </p>
        )
      ) : (
        <p className="platform-access-empty" role="status">
          {domainsResource.status === "loading"
            ? previousDomains
              ? `正在重新验证商城数据范围；保留的 ${previousDomains.length} 条旧记录不能用于接入。`
              : "正在读取商城数据范围…"
            : previousDomains
              ? `商城数据范围暂时不可用；保留的 ${previousDomains.length} 条旧记录不能用于接入。`
              : "商城数据范围暂时不可用，远程店铺接入已暂停。"}
        </p>
      )}
      {invite ? (
        <div className="remote-store-token">
          <div>
            <strong>一次性连接信息</strong>
            <small>远程服务提交地址</small>
            <code>{invite.url}</code>
            <small>
              凭据将在 {new Date(invite.expiresAt).toLocaleString()}{" "}
              失效；已接入店铺不受影响
            </small>
            <code>{invite.token}</code>
          </div>
          <Button
            variant="outline"
            size="md"
            className="min-h-11"
            type="button"
            onClick={() => void copyInvite()}
          >
            <Clipboard size={15} aria-hidden="true" />
            复制凭据
          </Button>
          <Button
            variant="ghost"
            size="md"
            className="min-h-11"
            type="button"
            onClick={() => setInvite(null)}
          >
            关闭
          </Button>
        </div>
      ) : null}
      <div className="remote-store-list-heading">
        <div>
          <strong>已接入的远程店铺</strong>
          <small>持久连接；可随时检查或主动断开</small>
        </div>
        <span>
          {bindingsStatus === "loading" && bindings.length === 0
            ? "读取中"
            : bindingsStatus === "error" && bindings.length === 0
              ? "不可用"
              : `${bindings.length} 家`}
        </span>
      </div>
      <div className="remote-store-list" aria-label="已接入的远程店铺">
        {bindingsStatus === "loading" ? (
          <p className="platform-access-empty" role="status">
            {bindings.length > 0
              ? "正在更新远程店铺状态…"
              : "正在读取远程店铺…"}
          </p>
        ) : null}
        {bindingsStatus === "error" ? (
          <div className="hosted-store-load-error" role="alert">
            <div>
              <strong>远程店铺读取失败</strong>
              <p>{bindingsError ?? "暂时无法确认已接入的远程店铺。"}</p>
            </div>
            <Button
              variant="outline"
              size="md"
              className="min-h-11"
              type="button"
              onClick={() => void refresh().catch(() => undefined)}
            >
              <RefreshCw size={14} aria-hidden="true" />
              重新读取
            </Button>
          </div>
        ) : null}
        {bindings.length ? (
          bindings.map((binding) => (
            <div className="remote-store-row" key={binding.id}>
              <span className="remote-store-icon">
                {binding.status === "active" ? (
                  <CheckCircle2 size={18} aria-hidden="true" />
                ) : binding.status === "degraded" ? (
                  <XCircle size={18} aria-hidden="true" />
                ) : (
                  <Radio size={18} aria-hidden="true" />
                )}
              </span>
              <span className="remote-store-copy">
                <strong>{binding.displayName}</strong>
                <small className="remote-store-endpoint">
                  {binding.endpoint}
                </small>
                <small>
                  {bindingStatusLabel(binding)}
                  {binding.lastHealthAt
                    ? ` · 最近检查 ${new Date(binding.lastHealthAt).toLocaleString()}`
                    : ""}
                </small>
              </span>
              {binding.status === "pending" ? (
                <div className="remote-store-activation">
                  <label>
                    <span>服务端密钥变量</span>
                    <input
                      aria-label={`${binding.displayName} 的服务端密钥变量`}
                      value={
                        tokenEnv[binding.id] ?? defaultTokenEnv(binding.slug)
                      }
                      onChange={(event) =>
                        setTokenEnv((current) => ({
                          ...current,
                          [binding.id]: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <Button
                    variant="primary"
                    size="md"
                    className="min-h-11"
                    type="button"
                    disabled={loading || bindingsStatus === "loading"}
                    onClick={() => void activate(binding)}
                  >
                    确认接入
                  </Button>
                </div>
              ) : binding.status === "revoked" ? (
                <small>已断开</small>
              ) : (
                <div className="remote-store-actions">
                  <Button
                    variant="outline"
                    size="md"
                    className="min-h-11"
                    type="button"
                    disabled={loading || bindingsStatus === "loading"}
                    onClick={() => void probe(binding)}
                  >
                    <RefreshCw size={14} aria-hidden="true" />
                    检查连接
                  </Button>
                  <Button
                    variant="destructive"
                    size="md"
                    className="min-h-11"
                    type="button"
                    disabled={loading || bindingsStatus === "loading"}
                    onClick={() => void revoke(binding)}
                  >
                    断开
                  </Button>
                </div>
              )}
            </div>
          ))
        ) : bindingsStatus === "ready" ? (
          <p className="platform-access-empty" role="status">
            还没有接入远程店铺。
          </p>
        ) : null}
      </div>
    </section>
  );
}

function bindingStatusLabel(binding: FederationBindingRecord): string {
  if (binding.status === "active") return "连接正常";
  if (binding.status === "degraded")
    return binding.lastError ? `连接异常：${binding.lastError}` : "连接异常";
  if (binding.status === "pending") return "等待远程服务完成连接";
  if (binding.status === "revoked") return "已断开";
  return binding.status;
}

function defaultTokenEnv(slug: string): string {
  const key =
    slug
      .replace(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase() || "REMOTE";
  return `MATCHPLANE_${key}_MCP_TOKEN`;
}

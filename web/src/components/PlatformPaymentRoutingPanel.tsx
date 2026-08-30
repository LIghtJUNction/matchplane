"use client";

import { Button } from "@appica/ui-react/button";
import { AlertTriangle, CreditCard, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  paymentRoutingResourceData,
  type PaymentGatewayDraft,
  type PlatformPaymentRoutingController,
} from "../hooks/usePlatformPaymentRoutingResources";
import { SectionHeading } from "./Primitives";

interface PlatformPaymentRoutingPanelProps {
  controller: PlatformPaymentRoutingController;
  onNotice: (message: string) => void;
}

export function PlatformPaymentRoutingPanel({
  controller,
  onNotice,
}: PlatformPaymentRoutingPanelProps) {
  const [gatewayEditorOpen, setGatewayEditorOpen] = useState(false);
  const [routeEditorOpen, setRouteEditorOpen] = useState(false);
  const [gatewayName, setGatewayName] = useState("");
  const [gatewayKind, setGatewayKind] =
    useState<PaymentGatewayDraft["kind"]>("test");
  const [gatewayMode, setGatewayMode] = useState<"test" | "production">("test");
  const [gatewaySettings, setGatewaySettings] = useState("{}");
  const [gatewayCredentialRef, setGatewayCredentialRef] = useState("");
  const [routeGatewayId, setRouteGatewayId] = useState("");
  const [routeMethodCode, setRouteMethodCode] = useState("");
  const [routeCurrency, setRouteCurrency] = useState("");
  const [routePriority, setRoutePriority] = useState("100");
  const displayedGateways = paymentRoutingResourceData(controller.gateways);
  const displayedRoutes = paymentRoutingResourceData(controller.routes);
  const freshGateways =
    controller.gateways.status === "ready" ? controller.gateways.data : null;
  const enabledGateways = useMemo(
    () => freshGateways?.filter((gateway) => gateway.enabled) ?? [],
    [freshGateways],
  );
  const selectedGateway = enabledGateways.find(
    (gateway) => gateway.gateway_id === routeGatewayId,
  );
  const gatewayWritable =
    !controller.writeBlockReason && controller.gateways.status === "ready";
  const routeWritable =
    !controller.writeBlockReason &&
    controller.gateways.status === "ready" &&
    controller.routes.status === "ready";

  useEffect(() => {
    setRouteGatewayId((current) =>
      current &&
      !enabledGateways.some((gateway) => gateway.gateway_id === current)
        ? ""
        : current,
    );
  }, [enabledGateways]);

  const submitGateway = async () => {
    let settings: Record<string, unknown>;
    try {
      const parsed = JSON.parse(gatewaySettings) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error();
      settings = parsed as Record<string, unknown>;
    } catch {
      onNotice("支付网关 settings 必须是 JSON 对象");
      return;
    }
    if (!gatewayName.trim()) {
      onNotice("请填写支付网关名称");
      return;
    }
    if (gatewayMode === "production" && !gatewayCredentialRef.trim()) {
      onNotice("生产网关必须填写 secret reference；不接受明文密钥");
      return;
    }
    const committed = await controller.commitGateway({
      name: gatewayName.trim(),
      kind: gatewayKind,
      mode: gatewayMode,
      settings,
      credentialSecretRef: gatewayCredentialRef.trim() || undefined,
    });
    if (!committed) return;

    setGatewayEditorOpen(false);
    setGatewayName("");
    setGatewaySettings("{}");
    setGatewayCredentialRef("");
    await controller.refreshGateways();
  };

  const submitRoute = async () => {
    const priorityText = routePriority.trim();
    if (!/^\d+$/.test(priorityText)) {
      onNotice("优先级必须是 0 到 10000 的整数");
      return;
    }
    const priority = Number(priorityText);
    if (!selectedGateway) {
      onNotice("请先选择一个已保存且启用的支付网关");
      return;
    }
    if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/i.test(routeMethodCode.trim())) {
      onNotice("支付方式编码只能包含字母、数字、点、下划线、冒号或短横线");
      return;
    }
    if (!/^[A-Z]{3}$/.test(routeCurrency.trim().toUpperCase())) {
      onNotice("币种必须是 3 位 ISO 4217 编码");
      return;
    }
    if (!Number.isSafeInteger(priority) || priority < 0 || priority > 10_000) {
      onNotice("优先级必须是 0 到 10000 的整数");
      return;
    }
    const committed = await controller.commitRoute({
      gatewayId: selectedGateway.gateway_id,
      methodCode: routeMethodCode.trim(),
      currency: routeCurrency.trim().toUpperCase(),
      priority,
    });
    if (!committed) return;

    setRouteEditorOpen(false);
    setRouteGatewayId("");
    setRouteMethodCode("");
    setRouteCurrency("");
    setRoutePriority("100");
    await controller.refreshRoutes();
  };

  return (
    <div className="platform-payment-routing">
      <PaymentRoutingNotice controller={controller} onNotice={onNotice} />
      {controller.writeBlockReason &&
      (displayedGateways !== undefined || displayedRoutes !== undefined) ? (
        <p className="payment-routing-status" role="status">
          {controller.writeBlockReason}
        </p>
      ) : null}

      <SectionHeading
        eyebrow="可选能力"
        title="线上支付网关"
        action={
          gatewayEditorOpen
            ? "关闭配置"
            : gatewayWritable
              ? "配置网关"
              : undefined
        }
        onAction={() => setGatewayEditorOpen((current) => !current)}
      />

      {resourceStaleText(controller.gateways, "支付网关") ? (
        <p className="payment-routing-stale" role="status">
          {resourceStaleText(controller.gateways, "支付网关")}
        </p>
      ) : null}

      {displayedGateways?.length ? (
        <div className="gateway-list">
          {displayedGateways.map((gateway) => (
            <div className="gateway-row" key={gateway.gateway_id}>
              <span className="gateway-row-icon">
                <CreditCard size={18} aria-hidden="true" />
              </span>
              <span>
                <strong>{gateway.name}</strong>
                <small>
                  {gateway.kind} · {gateway.mode} · v{gateway.version}
                </small>
              </span>
              <b
                className={
                  gateway.enabled ? "status-chip is-on" : "status-chip"
                }
              >
                {gateway.enabled ? "启用" : "停用"}
              </b>
            </div>
          ))}
        </div>
      ) : controller.gateways.status === "ready" ? (
        <div className="gateway-empty">
          <CreditCard size={24} aria-hidden="true" />
          <strong>暂不使用线上支付</strong>
          <p>
            这不会阻断撮合。默认在双方同意后交换微信和手机号；需要平台内收款时再配置网关。
          </p>
          <Button
            variant="outline"
            size="md"
            className="min-h-11"
            type="button"
            disabled={!gatewayWritable}
            onClick={() => setGatewayEditorOpen(true)}
          >
            打开配置
          </Button>
        </div>
      ) : null}

      {gatewayEditorOpen ? (
        <form
          className="admin-editor"
          aria-label="支付网关配置"
          onSubmit={(event) => {
            event.preventDefault();
            void submitGateway();
          }}
        >
          <div className="admin-editor-heading">
            <strong>新增支付网关</strong>
            <Button
              variant="ghost"
              size="md"
              className="min-h-11"
              type="button"
              onClick={() => setGatewayEditorOpen(false)}
            >
              关闭
            </Button>
          </div>
          <label>
            <span>名称</span>
            <input
              required
              value={gatewayName}
              onChange={(event) => setGatewayName(event.target.value)}
              placeholder="例如：微信支付主商户"
            />
          </label>
          <label>
            <span>协议</span>
            <select
              required
              value={gatewayKind}
              onChange={(event) =>
                setGatewayKind(
                  event.target.value as PaymentGatewayDraft["kind"],
                )
              }
            >
              <option value="test">测试网关</option>
              <option value="epay">EPay</option>
              <option value="waffo_pancake">Waffo Pancake</option>
              <option value="wechat_pay_v3">微信支付 API v3</option>
              <option value="alipay_openapi">支付宝 OpenAPI</option>
            </select>
          </label>
          <label>
            <span>模式</span>
            <select
              required
              value={gatewayMode}
              onChange={(event) =>
                setGatewayMode(event.target.value as "test" | "production")
              }
            >
              <option value="test">测试</option>
              <option value="production">生产</option>
            </select>
          </label>
          <label>
            <span>secret reference</span>
            <input
              required={gatewayMode === "production"}
              value={gatewayCredentialRef}
              onChange={(event) => setGatewayCredentialRef(event.target.value)}
              placeholder="file:///run/secrets/payment/wechat.json"
            />
          </label>
          <label>
            <span>settings（JSON）</span>
            <textarea
              required
              value={gatewaySettings}
              onChange={(event) => setGatewaySettings(event.target.value)}
              rows={4}
              spellCheck={false}
            />
          </label>
          <Button
            variant="primary"
            size="md"
            className="min-h-11"
            type="submit"
            disabled={
              controller.mutation !== null ||
              !gatewayWritable ||
              !gatewayName.trim()
            }
          >
            {controller.mutation === "gateway" ? "保存中…" : "保存网关"}
          </Button>
        </form>
      ) : null}

      <div className="route-manager">
        <div className="subsection-heading">
          <div>
            <p className="eyebrow">路由矩阵</p>
            <strong>支付方式与币种</strong>
          </div>
          <Button
            variant="outline"
            size="md"
            className="min-h-11"
            type="button"
            disabled={!routeEditorOpen && !routeWritable}
            onClick={() => setRouteEditorOpen((current) => !current)}
          >
            {routeEditorOpen ? "关闭配置" : "配置路由"}
          </Button>
        </div>

        {resourceStaleText(controller.routes, "支付路由") ? (
          <p className="payment-routing-stale" role="status">
            {resourceStaleText(controller.routes, "支付路由")}
          </p>
        ) : null}

        {displayedRoutes?.length ? (
          <div className="route-list" aria-label="已配置支付路由">
            {displayedRoutes.map((route) => (
              <div className="route-row" key={route.route_id}>
                <span>
                  <strong>{route.method_code}</strong>
                  <small>
                    {displayedGateways?.find(
                      (gateway) => gateway.gateway_id === route.gateway_id,
                    )?.name || route.gateway_id}{" "}
                    · {route.currency} · 优先级 {route.priority}
                  </small>
                </span>
                <b
                  className={
                    route.enabled ? "status-chip is-on" : "status-chip"
                  }
                >
                  {route.enabled ? "启用" : "停用"}
                </b>
              </div>
            ))}
          </div>
        ) : controller.routes.status === "ready" ? (
          <p className="route-empty">
            线上支付为可选；添加网关后，再为微信支付、支付宝或其他协议指定币种。
          </p>
        ) : null}

        {routeEditorOpen ? (
          <form
            className="admin-editor route-editor"
            aria-label="支付路由配置"
            onSubmit={(event) => {
              event.preventDefault();
              void submitRoute();
            }}
          >
            <div className="admin-editor-heading">
              <strong>新增支付路由</strong>
              <Button
                variant="ghost"
                size="md"
                className="min-h-11"
                type="button"
                onClick={() => setRouteEditorOpen(false)}
              >
                关闭
              </Button>
            </div>
            <label>
              <span>支付网关</span>
              <select
                required
                value={routeGatewayId}
                disabled={controller.gateways.status !== "ready"}
                onChange={(event) => setRouteGatewayId(event.target.value)}
              >
                <option value="">选择已保存且启用的网关</option>
                {enabledGateways.map((gateway) => (
                  <option key={gateway.gateway_id} value={gateway.gateway_id}>
                    {gateway.name} · {gateway.kind}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>方式编码</span>
              <input
                required
                minLength={1}
                maxLength={64}
                pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,63}"
                value={routeMethodCode}
                onChange={(event) => setRouteMethodCode(event.target.value)}
                placeholder="由网关协议定义"
              />
            </label>
            <div className="route-editor-grid">
              <label>
                <span>币种</span>
                <input
                  required
                  minLength={3}
                  value={routeCurrency}
                  onChange={(event) =>
                    setRouteCurrency(event.target.value.toUpperCase())
                  }
                  maxLength={3}
                  placeholder="ISO 4217"
                />
              </label>
              <label>
                <span>优先级</span>
                <input
                  required
                  inputMode="numeric"
                  pattern="[0-9]+"
                  value={routePriority}
                  onChange={(event) => setRoutePriority(event.target.value)}
                />
              </label>
            </div>
            <Button
              variant="primary"
              size="md"
              className="min-h-11"
              type="submit"
              disabled={
                controller.mutation !== null ||
                !routeWritable ||
                !selectedGateway
              }
            >
              {controller.mutation === "route" ? "保存中…" : "保存路由"}
            </Button>
          </form>
        ) : null}
      </div>
    </div>
  );
}

function PaymentRoutingNotice({
  controller,
}: PlatformPaymentRoutingPanelProps) {
  const failures: Array<{ label: string; message: string }> = [];
  if (controller.gateways.status === "error")
    failures.push({ label: "支付网关", message: controller.gateways.message });
  if (controller.routes.status === "error")
    failures.push({ label: "支付路由", message: controller.routes.message });
  if (failures.length) {
    return (
      <div className="payment-routing-alert" role="alert">
        <AlertTriangle aria-hidden="true" size={18} />
        <div>
          <strong>部分支付配置暂时不可用</strong>
          <ul>
            {failures.map((failure) => (
              <li key={failure.label}>
                {failure.label}：{failure.message}
              </li>
            ))}
          </ul>
        </div>
        <Button
          variant="outline"
          size="md"
          className="min-h-11"
          type="button"
          disabled={!controller.retryAvailable}
          onClick={() => void controller.retryFailed()}
        >
          <RefreshCw aria-hidden="true" size={14} />
          重试失败项
        </Button>
      </div>
    );
  }

  const loading = [controller.gateways, controller.routes].filter(
    (resource) => resource.status === "loading",
  ).length;
  return loading ? (
    <p className="payment-routing-status" role="status">
      正在验证{loading === 2 ? "支付网关与路由" : "部分支付配置"}
      ；已完成的状态保持可用。
    </p>
  ) : null;
}

function resourceStaleText(
  resource:
    | PlatformPaymentRoutingController["gateways"]
    | PlatformPaymentRoutingController["routes"],
  label: string,
): string | null {
  if (resource.status === "ready" || resource.previous === undefined)
    return null;
  return resource.status === "loading"
    ? `${label}正在重新验证；当前展示上次结果。`
    : `${label}当前待验证；仅展示上次结果，配置操作已暂停。`;
}

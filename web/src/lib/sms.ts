import { randomInt } from "node:crypto";

import { fetchPinnedPublicText } from "./pinned-public-endpoint";
import { isProductionEnvironment } from "./runtime";
import { readManagedSmsGatewayConfig } from "./sms-gateway-config";

const SMS_GATEWAY_TIMEOUT_MS = 3_000;
const SMS_GATEWAY_RESPONSE_LIMIT_BYTES = 64 * 1024;

type SmsPayload = {
  phoneNumber: string;
  code: string;
};

interface SmsGatewayRoute {
  url: string;
  token: string | null;
}

/**
 * The authentication plugin owns OTP generation and persistence. This adapter
 * only hands the already-generated code to an operator-owned SMS gateway.
 * No provider credentials or vendor-specific request shape are stored in the
 * auth layer. The console-managed gateway (sms-gateway-config) is preferred;
 * deployment variables remain a bootstrap fallback, mirroring the root email route.
 */
export async function sendConfiguredPhoneOtp({ phoneNumber, code }: SmsPayload): Promise<void> {
  const route = activeSmsGatewayRoute();
  if (!route) {
    throw new Error("手机号验证码服务尚未配置");
  }
  await postToGateway(route, { phoneNumber, code, purpose: "sign-in" });
}

/**
 * Fixed-content operator verification for a saved gateway. The enabled flag is
 * deliberately not required so the route can be proven before it is offered on
 * the login screen; the caller must already restrict this to the mall owner.
 */
export async function sendSmsGatewayConfigTest(phoneNumber: string): Promise<void> {
  const managed = readManagedSmsGatewayConfig();
  const route: SmsGatewayRoute | null = managed
    ? { url: managed.gatewayUrl, token: managed.token }
    : envSmsGatewayRoute(process.env);
  if (!route) {
    throw new Error("请先保存短信网关地址");
  }
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  await postToGateway(route, { phoneNumber, code, purpose: "config-test" });
}

/** Return whether the deployment can deliver a phone OTP right now. */
export function isPhoneOtpConfigured(environment: Record<string, string | undefined> = process.env): boolean {
  return Boolean(activeSmsGatewayRoute(environment));
}

function activeSmsGatewayRoute(environment: Record<string, string | undefined> = process.env): SmsGatewayRoute | null {
  const managed = readManagedSmsGatewayConfig();
  if (managed?.enabled) return { url: managed.gatewayUrl, token: managed.token };
  return envSmsGatewayRoute(environment);
}

function envSmsGatewayRoute(environment: Record<string, string | undefined>): SmsGatewayRoute | null {
  const endpoint = environment.MATCHPLANE_SMS_PROVIDER_URL?.trim();
  const url = endpoint ? safeProviderUrl(endpoint) : null;
  if (!url) return null;
  return { url, token: environment.MATCHPLANE_SMS_PROVIDER_TOKEN?.trim() || null };
}

async function postToGateway(route: SmsGatewayRoute, body: SmsPayload & { purpose: string }): Promise<void> {
  let url: URL;
  try {
    url = new URL(route.url);
  } catch {
    throw new Error("短信网关地址无效");
  }
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
  });
  if (route.token) headers.set("authorization", `Bearer ${route.token}`);

  const { response } = await fetchPinnedPublicText(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SMS_GATEWAY_TIMEOUT_MS),
    requestTimeoutMs: SMS_GATEWAY_TIMEOUT_MS,
    responseBodyTimeoutMs: SMS_GATEWAY_TIMEOUT_MS,
    responseLimitBytes: SMS_GATEWAY_RESPONSE_LIMIT_BYTES,
    allowLoopback: isAllowedDevelopmentLoopback(url),
  });
  if (!response.ok) {
    throw new Error(`SMS provider returned HTTP ${response.status}`);
  }
}

function safeProviderUrl(value: string): string | null {
  try {
    const normalized = value.trim();
    if (!normalized || normalized.length > 2_048) return null;
    const url = new URL(normalized);
    if (url.username || url.password || url.hash) return null;
    if (url.protocol === "https:") return url.toString();
    return isAllowedDevelopmentLoopback(url) ? url.toString() : null;
  } catch {
    return null;
  }
}

function isAllowedDevelopmentLoopback(url: URL): boolean {
  return (
    !isProductionEnvironment() &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  );
}

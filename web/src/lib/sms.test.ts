import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./pinned-public-endpoint", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pinned-public-endpoint")>()),
  fetchPinnedPublicText: vi.fn(async (url: URL, options: {
    method?: "GET" | "POST";
    headers?: HeadersInit;
    body?: BodyInit;
    signal?: AbortSignal;
  }) => {
    const response = await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: options.signal,
      redirect: "manual",
      credentials: "omit",
    });
    return { response, text: await response.text() };
  }),
}));

import { isPhoneOtpConfigured, sendConfiguredPhoneOtp, sendSmsGatewayConfigTest } from "./sms";
import { saveManagedSmsGatewayConfig } from "./sms-gateway-config";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "sms-adapter-"));
  vi.stubEnv("MATCHPLANE_ROOT_SECRET_DIR", root);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe("isPhoneOtpConfigured", () => {
  it("rejects an absent or unsafe endpoint", () => {
    expect(isPhoneOtpConfigured({})).toBe(false);
    expect(isPhoneOtpConfigured({ MATCHPLANE_SMS_PROVIDER_URL: "http://sms.example.test" })).toBe(false);
  });

  it("accepts an HTTPS gateway endpoint", () => {
    expect(isPhoneOtpConfigured({ MATCHPLANE_SMS_PROVIDER_URL: "https://sms.example.test/send" })).toBe(true);
  });

  it("rejects embedded credentials and production loopback endpoints", () => {
    expect(isPhoneOtpConfigured({
      MATCHPLANE_SMS_PROVIDER_URL: "https://token@sms.example.test/send",
    })).toBe(false);
    vi.stubEnv("MATCHPLANE_ENVIRONMENT", "production");
    expect(isPhoneOtpConfigured({
      MATCHPLANE_SMS_PROVIDER_URL: "http://localhost:9080/send",
    })).toBe(false);
  });

  it("prefers an enabled console-managed gateway over deployment variables", () => {
    saveManagedSmsGatewayConfig({ enabled: true, gatewayUrl: "https://managed.example.test/send" });
    expect(isPhoneOtpConfigured({})).toBe(true);
  });

  it("falls back to deployment variables while the managed gateway stays disabled", () => {
    saveManagedSmsGatewayConfig({ enabled: false, gatewayUrl: "https://managed.example.test/send" });
    expect(isPhoneOtpConfigured({})).toBe(false);
    expect(isPhoneOtpConfigured({ MATCHPLANE_SMS_PROVIDER_URL: "https://sms.example.test/send" })).toBe(true);
  });
});

describe("sendConfiguredPhoneOtp", () => {
  it("posts the sign-in code to the managed gateway with its bearer token", async () => {
    saveManagedSmsGatewayConfig({ enabled: true, gatewayUrl: "http://localhost:9080/send", token: "gateway-secret" });
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    await sendConfiguredPhoneOtp({ phoneNumber: "+8613800000000", code: "123456" });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("http://localhost:9080/send");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer gateway-secret");
    expect(JSON.parse(String(init.body))).toEqual({
      phoneNumber: "+8613800000000",
      code: "123456",
      purpose: "sign-in",
    });
  });

  it("refuses to send when nothing is configured", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(sendConfiguredPhoneOtp({ phoneNumber: "+8613800000000", code: "123456" })).rejects.toThrow("尚未配置");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("sendSmsGatewayConfigTest", () => {
  it("delivers a fixed-purpose test code even before the gateway is enabled", async () => {
    saveManagedSmsGatewayConfig({ enabled: false, gatewayUrl: "http://localhost:9080/send" });
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    await sendSmsGatewayConfigTest("+8613800000000");

    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { phoneNumber: string; code: string; purpose: string };
    expect(body.phoneNumber).toBe("+8613800000000");
    expect(body.purpose).toBe("config-test");
    expect(body.code).toMatch(/^\d{6}$/);
  });

  it("surfaces a gateway failure to the operator", async () => {
    saveManagedSmsGatewayConfig({ enabled: true, gatewayUrl: "https://managed.example.test/send" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await expect(sendSmsGatewayConfigTest("+8613800000000")).rejects.toThrow("HTTP 500");
  });

  it("asks for a saved gateway before testing", async () => {
    await expect(sendSmsGatewayConfigTest("+8613800000000")).rejects.toThrow("请先保存短信网关地址");
  });
});

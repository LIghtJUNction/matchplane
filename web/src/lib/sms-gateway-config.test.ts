import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getManagedSmsGatewayConfig,
  readManagedSmsGatewayConfig,
  saveManagedSmsGatewayConfig,
} from "./sms-gateway-config";

describe("managed SMS gateway config", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "sms-gateway-config-"));
    vi.stubEnv("MATCHPLANE_ROOT_SECRET_DIR", root);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("returns null before an operator has saved anything", () => {
    expect(getManagedSmsGatewayConfig()).toBeNull();
    expect(readManagedSmsGatewayConfig()).toBeNull();
  });

  it("round-trips a gateway and keeps the token out of the public view", () => {
    const saved = saveManagedSmsGatewayConfig({
      enabled: true,
      gatewayUrl: "https://sms.example.test/send",
      token: "gateway-secret",
    });
    expect(saved).toEqual({
      enabled: true,
      gatewayUrl: "https://sms.example.test/send",
      tokenConfigured: true,
    });
    expect(readManagedSmsGatewayConfig()).toEqual({
      enabled: true,
      gatewayUrl: "https://sms.example.test/send",
      token: "gateway-secret",
    });
    expect(JSON.stringify(getManagedSmsGatewayConfig())).not.toContain("gateway-secret");
    expect(readFileSync(path.join(root, "sms-gateway.json"), "utf8")).not.toContain("gateway-secret");
  });

  it("keeps the existing token when a save omits it", () => {
    saveManagedSmsGatewayConfig({ enabled: false, gatewayUrl: "https://sms.example.test/send", token: "gateway-secret" });
    const resaved = saveManagedSmsGatewayConfig({ enabled: true, gatewayUrl: "https://sms.example.test/v2/send" });
    expect(resaved.tokenConfigured).toBe(true);
    expect(readManagedSmsGatewayConfig()?.token).toBe("gateway-secret");
  });

  it("accepts a plain-HTTP loopback mock for local demos", () => {
    const saved = saveManagedSmsGatewayConfig({ enabled: true, gatewayUrl: "http://localhost:9080/send" });
    expect(saved.gatewayUrl).toBe("http://localhost:9080/send");
    expect(saved.tokenConfigured).toBe(false);
  });

  it("rejects a plain-HTTP loopback gateway in production", () => {
    vi.stubEnv("MATCHPLANE_ENVIRONMENT", "production");
    expect(() =>
      saveManagedSmsGatewayConfig({
        enabled: true,
        gatewayUrl: "http://localhost:9080/send",
      }),
    ).toThrow("短信网关地址");
  });

  it("rejects unsafe gateway addresses", () => {
    for (const gatewayUrl of [
      "",
      "http://sms.example.test/send",
      "https://user:pass@sms.example.test/send",
      "https://sms.example.test/send#fragment",
      "ftp://sms.example.test/send",
    ]) {
      expect(() => saveManagedSmsGatewayConfig({ enabled: true, gatewayUrl })).toThrow("短信网关地址");
    }
    expect(getManagedSmsGatewayConfig()).toBeNull();
  });
});

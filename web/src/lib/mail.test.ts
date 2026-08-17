import { afterEach, describe, expect, it, vi } from "vitest";

import { isRootEmailAuthConfigured, rootEmailRouteFromEnv } from "./mail";

describe("rootEmailRouteFromEnv", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns no route until the deployment supplies root SMTP settings", () => {
    expect(rootEmailRouteFromEnv("production")).toBeNull();
  });

  it("accepts a file-backed credential reference without exposing a password", () => {
    vi.stubEnv("MATCHPLANE_ROOT_SMTP_HOST", "smtp.example.test");
    vi.stubEnv("MATCHPLANE_ROOT_SMTP_PORT", "587");
    vi.stubEnv("MATCHPLANE_ROOT_SMTP_TLS_MODE", "starttls");
    vi.stubEnv("MATCHPLANE_ROOT_SMTP_USERNAME", "no-reply@example.test");
    vi.stubEnv("MATCHPLANE_ROOT_SMTP_CREDENTIAL_SECRET_REF", "file:///run/secrets/root-smtp-password");
    vi.stubEnv("MATCHPLANE_ROOT_SMTP_FROM_ADDRESS", "no-reply@example.test");

    const route = rootEmailRouteFromEnv("production");
    expect(route).toMatchObject({
      providerKey: "root-smtp",
      smtpHost: "smtp.example.test",
      smtpPort: 587,
      tlsMode: "starttls",
      credentialSecretRef: "file:///run/secrets/root-smtp-password",
      mode: "production",
      enabled: true,
    });
  });

  it("fails closed when a partial root route is configured", () => {
    vi.stubEnv("MATCHPLANE_ROOT_SMTP_HOST", "smtp.example.test");
    expect(() => rootEmailRouteFromEnv("production")).toThrow(/SMTP/);
    expect(isRootEmailAuthConfigured()).toBe(false);
  });

  it("reports a complete enabled route as an available auth capability", () => {
    vi.stubEnv("MATCHPLANE_ROOT_SMTP_HOST", "smtp.example.test");
    vi.stubEnv("MATCHPLANE_ROOT_SMTP_PORT", "587");
    vi.stubEnv("MATCHPLANE_ROOT_SMTP_TLS_MODE", "starttls");
    vi.stubEnv("MATCHPLANE_ROOT_SMTP_USERNAME", "no-reply@example.test");
    vi.stubEnv("MATCHPLANE_ROOT_SMTP_CREDENTIAL_SECRET_REF", "env://MATCHPLANE_TEST_SMTP_PASSWORD");
    vi.stubEnv("MATCHPLANE_ROOT_SMTP_FROM_ADDRESS", "no-reply@example.test");
    expect(isRootEmailAuthConfigured()).toBe(true);
  });
});

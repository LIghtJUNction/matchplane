import { describe, expect, it } from "vitest";
import { buildPlatformRouterAuditRecord } from "./audit";

describe("platform router audit", () => {
  it("records the root actor and only bounded non-secret provider fields", () => {
    const record = buildPlatformRouterAuditRecord(
      {
        action: "activate",
        actor: "root-super-admin-id",
        requestId: "request-id",
        endpoint: "https://api.lmm.best/v1",
        model: "gpt-5.6-sol",
        enabled: true,
        keyChanged: true,
      },
      new Date("2026-08-25T00:00:00.000Z"),
    );
    const encoded = JSON.stringify(record);

    expect(record).toEqual({
      at: "2026-08-25T00:00:00.000Z",
      action: "activate",
      actor: "root-super-admin-id",
      requestId: "request-id",
      endpointOrigin: "https://api.lmm.best",
      model: "gpt-5.6-sol",
      enabled: true,
      keyChanged: true,
    });
    expect(encoded).not.toContain("apiKey");
    expect(encoded).not.toContain("fingerprint");
  });
});

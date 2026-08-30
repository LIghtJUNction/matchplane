import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import { canonicalJson, verifyFederationEnrollment } from "./federation-contract";

const manifest = {
  apiVersion: "matchplane.subplatform/v1",
  rootApiVersion: "v1",
  id: "remote-market",
  slug: "remote-market",
  displayName: "Remote market",
  requiredScopes: ["marketplace:read"],
  agent: { protocol: "matchplane.agent/v1", mcpTools: ["catalog.search"] },
};

function signedEnrollment(
  signedManifest: Record<string, unknown> = manifest,
) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const input = {
    protocol: "matchplane.federation/v1",
    nodeId: "018f0d5f-8c30-7b46-9f2b-2b0bf28a2ef0",
    slug: "remote-market",
    displayName: "Remote market",
    endpoint: "http://localhost:9191/mcp",
    mcpServerKey: "remote-market",
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    manifest: signedManifest,
  };
  const signedPayload = canonicalJson({
    displayName: input.displayName,
    endpoint: input.endpoint,
    manifest: input.manifest,
    mcpServerKey: input.mcpServerKey,
    nodeId: input.nodeId,
    protocol: input.protocol,
    slug: input.slug,
  });
  return {
    ...input,
    signature: sign(null, Buffer.from(signedPayload), privateKey).toString("base64"),
  };
}

describe("federation enrollment contract", () => {
  it("accepts a valid Ed25519 signed manifest and computes its digest", () => {
    const result = verifyFederationEnrollment(signedEnrollment(), "test");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(result.value.endpoint).toBe("http://localhost:9191/mcp");
    }
  });

  it("rejects a signature after a signed field changes", () => {
    const enrollment = signedEnrollment();
    const result = verifyFederationEnrollment({ ...enrollment, slug: "other-market" }, "test");
    expect(result).toEqual({ ok: false, error: "manifest.slug 与入驻 slug 不一致" });
  });

  it("rejects production HTTP and query-bearing endpoints", () => {
    const enrollment = signedEnrollment();
    expect(verifyFederationEnrollment(enrollment, "production")).toEqual({
      ok: false,
      error: "endpoint 必须是安全的 HTTPS MCP 地址",
    });
    const changed = { ...enrollment, endpoint: "https://remote.example/other" };
    expect(verifyFederationEnrollment(changed, "production")).toEqual({
      ok: false,
      error: "联邦清单签名校验失败",
    });
  });

  it("accepts the same product-template contract as local registration", () => {
    const result = verifyFederationEnrollment(
      signedEnrollment({
        ...manifest,
        productTemplates: [
          {
            id: "camera",
            label: "Camera",
            supplyFields: [{ key: "sensor", label: "Sensor" }],
          },
          {
            id: "lens",
            label: "Lens",
            supplyFields: [{ key: "mount", label: "Mount" }],
          },
        ],
        defaultProductTemplateId: "camera",
      }),
      "test",
    );

    expect(result.ok).toBe(true);
  });

  it("rejects ambiguous legacy fields, missing defaults, and unknown keys", () => {
    expect(
      verifyFederationEnrollment(
        signedEnrollment({
          ...manifest,
          ui: { supplyFields: [{ key: "brand", label: "Brand" }] },
          productTemplates: [
            { id: "camera", label: "Camera", supplyFields: [] },
          ],
        }),
        "test",
      ),
    ).toEqual({ ok: false, error: "manifest.productTemplates 无效" });
    expect(
      verifyFederationEnrollment(
        signedEnrollment({
          ...manifest,
          productTemplates: [
            { id: "camera", label: "Camera", supplyFields: [] },
            { id: "lens", label: "Lens", supplyFields: [] },
          ],
        }),
        "test",
      ),
    ).toEqual({ ok: false, error: "manifest.productTemplates 无效" });
    expect(
      verifyFederationEnrollment(
        signedEnrollment({ ...manifest, privateSettings: true }),
        "test",
      ),
    ).toEqual({
      ok: false,
      error: "manifest 包含未声明字段: privateSettings",
    });
  });
});

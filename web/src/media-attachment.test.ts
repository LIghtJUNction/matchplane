import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_MEDIA_BYTES,
  extractMcpMediaUploadResult,
  parseMediaUploadRequest,
  parseMediaUploadResponse,
} from "./media-attachment";

const tenantId = "11111111-1111-4111-8111-111111111111";
const domainId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const sha256 = "a".repeat(64);

function uploadRequest() {
  return {
    protocol: "matchplane.media/v1",
    request_id: requestId,
    scope: { tenant_id: tenantId, domain_id: domainId, platform_path: "/store-a" },
    attachment: {
      kind: "image",
      file_name: "front.png",
      media_type: "image/png",
      size_bytes: 3,
      data_base64: "AQID",
    },
  };
}

describe("media attachment ABI v1", () => {
  it("uses a 25 MiB default while retaining the protocol hard ceiling", () => {
    expect(DEFAULT_MAX_MEDIA_BYTES).toBe(25 * 1024 * 1024);
  });

  it("normalizes a scoped upload without interpreting domain fields", () => {
    const parsed = parseMediaUploadRequest(uploadRequest());
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) {
      expect(parsed.value.scope.platform_path).toBe("/store-a");
      expect(parsed.value.attachment.size_bytes).toBe(3);
    }
  });

  it("rejects mismatched bytes, unsupported MIME types, and the root path", () => {
    expect(parseMediaUploadRequest({ ...uploadRequest(), attachment: { ...uploadRequest().attachment, size_bytes: 4 } })).toMatchObject({ ok: false });
    expect(parseMediaUploadRequest({ ...uploadRequest(), attachment: { ...uploadRequest().attachment, media_type: "application/octet-stream" } })).toMatchObject({ ok: false });
    expect(parseMediaUploadRequest({ ...uploadRequest(), scope: { ...uploadRequest().scope, platform_path: "/" } })).toMatchObject({ ok: false });
  });

  it("extracts and validates a child-owned opaque reference", () => {
    const payload = {
      jsonrpc: "2.0",
      id: requestId,
      result: {
        content: [{ type: "text", text: JSON.stringify({
          protocol: "matchplane.media/v1",
          request_id: requestId,
          attachment: {
            attachment_ref: "media://store-a/front.png",
            kind: "image",
            file_name: "front.png",
            media_type: "image/png",
            size_bytes: 3,
            sha256,
            width: 1200,
            height: 800,
          },
        }) }],
      },
    };
    const extracted = extractMcpMediaUploadResult(payload);
    expect(extracted).toMatchObject({ ok: true });
    if (!extracted.ok) return;
    const parsed = parseMediaUploadResponse(extracted.value, requestId);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.value.attachment.attachment_ref).toBe("media://store-a/front.png");
  });

  it("requires the child response to preserve the request id", () => {
    expect(parseMediaUploadResponse({
      protocol: "matchplane.media/v1",
      request_id: tenantId,
      attachment: {
        attachment_ref: "media://store-a/front.png",
        kind: "image",
        file_name: "front.png",
        media_type: "image/png",
        size_bytes: 3,
        sha256,
      },
    }, requestId)).toMatchObject({ ok: false });
  });
});

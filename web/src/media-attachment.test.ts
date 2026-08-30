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
    scope: {
      tenant_id: tenantId,
      domain_id: domainId,
      platform_path: "/store-a",
    },
    attachment: {
      kind: "image",
      file_name: "front.png",
      media_type: "image/png",
      size_bytes: 3,
      data_base64: "AQID",
    },
  };
}

function uploadRequestWithBytes(sizeBytes: number) {
  return {
    ...uploadRequest(),
    attachment: {
      ...uploadRequest().attachment,
      size_bytes: sizeBytes,
      data_base64: Buffer.alloc(sizeBytes, 0x61).toString("base64"),
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
    expect(
      parseMediaUploadRequest({
        ...uploadRequest(),
        attachment: { ...uploadRequest().attachment, size_bytes: 4 },
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseMediaUploadRequest({
        ...uploadRequest(),
        attachment: {
          ...uploadRequest().attachment,
          media_type: "application/octet-stream",
        },
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseMediaUploadRequest({
        ...uploadRequest(),
        scope: { ...uploadRequest().scope, platform_path: "/" },
      }),
    ).toMatchObject({ ok: false });
  });

  it.each([
    5, 10, 25,
  ])("validates a %i MiB base64 payload without overflowing the regular-expression stack", (sizeMiB) => {
    const sizeBytes = sizeMiB * 1024 * 1024;
    expect(
      parseMediaUploadRequest(uploadRequestWithBytes(sizeBytes)),
    ).toMatchObject({
      ok: true,
      value: { attachment: { size_bytes: sizeBytes } },
    });
  });

  it.each([
    "AQ?D",
    "AQI",
    "A===",
    "AQ=D",
    "AQID=",
  ])("rejects malformed base64 %j", (dataBase64) => {
    expect(
      parseMediaUploadRequest({
        ...uploadRequest(),
        attachment: {
          ...uploadRequest().attachment,
          data_base64: dataBase64,
        },
      }),
    ).toMatchObject({
      ok: false,
      error: "attachment.data_base64 must be valid base64",
    });
  });

  it("rejects payloads above the configured maximum before decoding", () => {
    expect(
      parseMediaUploadRequest({
        ...uploadRequest(),
        attachment: {
          ...uploadRequest().attachment,
          size_bytes: DEFAULT_MAX_MEDIA_BYTES + 1,
        },
      }),
    ).toMatchObject({ ok: false });
  });

  it("turns unexpected parser exceptions into a controlled validation failure", () => {
    const explosive = new Proxy(
      {},
      {
        ownKeys() {
          throw new RangeError("synthetic parser failure");
        },
      },
    );

    expect(() => parseMediaUploadRequest(explosive)).not.toThrow();
    expect(parseMediaUploadRequest(explosive)).toEqual({
      ok: false,
      error: "media upload could not be validated",
    });
  });

  it("extracts and validates a child-owned opaque reference", () => {
    const payload = {
      jsonrpc: "2.0",
      id: requestId,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
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
            }),
          },
        ],
      },
    };
    const extracted = extractMcpMediaUploadResult(payload);
    expect(extracted).toMatchObject({ ok: true });
    if (!extracted.ok) return;
    const parsed = parseMediaUploadResponse(extracted.value, requestId);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok)
      expect(parsed.value.attachment.attachment_ref).toBe(
        "media://store-a/front.png",
      );
  });

  it("requires the child response to preserve the request id", () => {
    expect(
      parseMediaUploadResponse(
        {
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
        },
        requestId,
      ),
    ).toMatchObject({ ok: false });
  });
});

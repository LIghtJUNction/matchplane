import { createHash, createPublicKey, verify } from "node:crypto";
import { isIP } from "node:net";
import { isUuid } from "./lib/uuid";

const FEDERATION_PROTOCOL = "matchplane.federation/v1";
const SERVER_KEY_PATTERN = /^[a-z0-9][a-z0-9._:-]{1,127}$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

export interface VerifiedFederationEnrollment {
  protocol: typeof FEDERATION_PROTOCOL;
  nodeId: string;
  slug: string;
  displayName: string;
  endpoint: string;
  mcpServerKey: string;
  publicKey: string;
  signature: string;
  manifest: Record<string, unknown>;
  manifestDigest: string;
}

/**
 * Validate a remote node's signed enrollment document without trusting any value from its
 * manifest as a secret, URL allowlist, or authorization scope. The returned digest is the
 * canonical identity of the manifest and is what gets persisted in the binding record.
 */
export function verifyFederationEnrollment(
  value: unknown,
  environment = process.env.MATCHPLANE_ENVIRONMENT,
):
  | { ok: true; value: VerifiedFederationEnrollment }
  | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "入驻报文必须是 JSON 对象" };
  if (value.protocol !== FEDERATION_PROTOCOL)
    return { ok: false, error: "不支持的联邦协议版本" };
  const nodeId = stringValue(value.nodeId, 64);
  const slug = stringValue(value.slug, 63);
  const displayName = stringValue(value.displayName, 200);
  const endpoint = stringValue(value.endpoint, 2_048);
  const mcpServerKey = stringValue(value.mcpServerKey, 128);
  const publicKey = stringValue(value.publicKey, 8_192);
  const signature = stringValue(value.signature, 8_192);
  if (!nodeId || !isUuid(nodeId))
    return { ok: false, error: "nodeId 必须是 UUID" };
  if (!slug || !SLUG_PATTERN.test(slug))
    return { ok: false, error: "slug 格式无效" };
  if (!displayName) return { ok: false, error: "displayName 必须填写" };
  if (!endpoint)
    return { ok: false, error: "endpoint 必须是安全的 HTTPS MCP 地址" };
  if (!mcpServerKey || !SERVER_KEY_PATTERN.test(mcpServerKey)) {
    return { ok: false, error: "mcpServerKey 格式无效" };
  }
  if (
    !publicKey ||
    !signature ||
    !isBase64(publicKey) ||
    !isBase64(signature)
  ) {
    return { ok: false, error: "publicKey 和 signature 必须是 base64" };
  }
  const normalizedEndpoint = normalizeFederationEndpoint(endpoint, environment);
  if (!normalizedEndpoint)
    return { ok: false, error: "endpoint 必须是安全的 HTTPS MCP 地址" };
  const manifest = value.manifest;
  if (!isRecord(manifest))
    return { ok: false, error: "manifest 必须是 JSON 对象" };
  const manifestError = validateManifest(manifest, slug);
  if (manifestError) return { ok: false, error: manifestError };

  const signedPayload = canonicalJson({
    displayName,
    endpoint: normalizedEndpoint,
    manifest,
    mcpServerKey,
    nodeId,
    protocol: FEDERATION_PROTOCOL,
    slug,
  });
  let signatureValid = false;
  try {
    const keyBytes = Buffer.from(publicKey, "base64");
    const signatureBytes = Buffer.from(signature, "base64");
    if (
      keyBytes.length < 32 ||
      keyBytes.length > 4_096 ||
      signatureBytes.length !== 64
    ) {
      return { ok: false, error: "联邦公钥或签名长度无效" };
    }
    const key = createPublicKey({ key: keyBytes, format: "der", type: "spki" });
    signatureValid = verify(
      null,
      Buffer.from(signedPayload),
      key,
      signatureBytes,
    );
  } catch {
    return { ok: false, error: "联邦公钥不是有效的 Ed25519 SPKI 公钥" };
  }
  if (!signatureValid) return { ok: false, error: "联邦清单签名校验失败" };

  return {
    ok: true,
    value: {
      protocol: FEDERATION_PROTOCOL,
      nodeId,
      slug,
      displayName,
      endpoint: normalizedEndpoint,
      mcpServerKey,
      publicKey,
      signature,
      manifest,
      manifestDigest: sha256Hex(canonicalJson(manifest)),
    },
  };
}

export function validateFederationTokenEnv(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "string" && ENV_NAME_PATTERN.test(value)
    ? value
    : null;
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort(compareCanonicalKeys)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("unsupported canonical JSON value");
}

function compareCanonicalKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateManifest(
  manifest: Record<string, unknown>,
  slug: string,
): string | null {
  const serialized = canonicalJson(manifest);
  if (serialized.length > 64 * 1024) return "manifest 不能超过 64 KiB";
  if (
    manifest.apiVersion !== "matchplane.subplatform/v1" ||
    manifest.rootApiVersion !== "v1"
  ) {
    return "manifest API 版本不受支持";
  }
  const id = stringValue(manifest.id, 128);
  const manifestSlug = stringValue(manifest.slug, 63);
  if (!id || !/^[a-z0-9][a-z0-9._-]{1,127}$/.test(id))
    return "manifest.id 格式无效";
  if (
    !manifestSlug ||
    manifestSlug !== slug ||
    !SLUG_PATTERN.test(manifestSlug)
  ) {
    return "manifest.slug 与入驻 slug 不一致";
  }
  const requiredScopes = manifest.requiredScopes;
  if (
    requiredScopes !== undefined &&
    (!Array.isArray(requiredScopes) ||
      requiredScopes.length > 32 ||
      requiredScopes.some(
        (item) =>
          typeof item !== "string" || item.length < 1 || item.length > 128,
      ))
  ) {
    return "manifest.requiredScopes 格式无效";
  }
  const agent = manifest.agent;
  if (agent !== undefined && !isRecord(agent))
    return "manifest.agent 必须是对象";
  if (isRecord(agent)) {
    if (
      agent.protocol !== undefined &&
      agent.protocol !== "matchplane.agent/v1"
    )
      return "manifest.agent.protocol 不受支持";
    const tools = agent.mcpTools;
    if (
      tools !== undefined &&
      (!Array.isArray(tools) ||
        tools.length > 64 ||
        tools.some(
          (item) => typeof item !== "string" || !SERVER_KEY_PATTERN.test(item),
        ))
    ) {
      return "manifest.agent.mcpTools 格式无效";
    }
  }
  return null;
}

function normalizeFederationEndpoint(
  value: string,
  environment: string | undefined,
): string | null {
  try {
    const url = new URL(value);
    const isLoopback =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]";
    if (
      url.protocol !== "https:" &&
      !(environment !== "production" && url.protocol === "http:" && isLoopback)
    )
      return null;
    if (url.username || url.password || url.hash || url.search) return null;
    if (environment === "production" && isPrivateIpLiteral(url.hostname))
      return null;
    return url.toString();
  } catch {
    return null;
  }
}

function isPrivateIpLiteral(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const version = isIP(normalized);
  if (version === 4) {
    const [first, second] = normalized.split(".").map(Number);
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127) ||
      first >= 224
    );
  }
  if (version === 6) {
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized)
    );
  }
  return false;
}

function isBase64(value: string): boolean {
  return (
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  );
}

function stringValue(value: unknown, maximum: number): string | null {
  return typeof value === "string" &&
    value.trim().length >= 1 &&
    value.length <= maximum
    ? value.trim()
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

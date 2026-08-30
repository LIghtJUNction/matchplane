import { normalizePlatformPath } from "./platform-agent-handoff";
import { isUuid } from "./lib/uuid";

export const RETRIEVAL_PROTOCOL = "matchplane.retrieval/v1" as const;

export interface RetrievalQuery {
  protocol: typeof RETRIEVAL_PROTOCOL;
  requestId: string;
  tenantId: string;
  domainId: string;
  platformPath: string;
  input: {
    narrative: string;
    requirements: Record<string, unknown>;
    budgetMin?: string | null;
    budgetMax?: string | null;
    currency?: string | null;
    currencyScale?: number | null;
  };
  limit: number;
  traceId?: string | null;
}

export interface RetrievalCandidate {
  /** Optional canonical catalogue asset. Generic offers may not have an asset row. */
  assetId?: string;
  /** Optional canonical offer reference used by the introduction API. */
  offerId?: string;
  /** Public projection fields are optional so a provider may keep its catalogue private. */
  displayName?: string;
  attributes?: Record<string, unknown>;
  terms?: Record<string, unknown>;
  score: number;
  reasons: string[];
  /** Explicit limitations or trade-offs; ranking providers must not hide them. */
  risks?: string[];
  metadata?: Record<string, unknown>;
}

export interface RetrievalResult {
  protocol: typeof RETRIEVAL_PROTOCOL;
  requestId: string;
  provider: {
    id: string;
    version: string;
    model?: string | null;
  };
  candidates: RetrievalCandidate[];
  degraded: boolean;
  generatedAt?: string | null;
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const TOOL_NAME_PATTERN = /^[a-z0-9][a-z0-9._:-]{1,127}$/;
const MAX_REQUIREMENTS_BYTES = 32 * 1024;
const MAX_METADATA_BYTES = 32 * 1024;
const CONTACT_FIELD_NAMES = new Set([
  "contact",
  "contact_details",
  "contact_info",
  "contact_method",
  "contact_phone",
  "contact_email",
  "email",
  "email_address",
  "phone",
  "phone_number",
  "telephone",
  "wechat",
  "wechat_id",
  "weixin",
  "whatsapp",
  "telegram",
  "skype",
]);
const CONTACT_VALUE_PATTERNS = [
  /(?:mailto:|tel:|sms:|(?:wechat|weixin|tg|skype|facetime):|https?:\/\/(?:wa\.me|api\.whatsapp\.com|t\.me|telegram\.me|line\.me)\/|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b)/i,
  /(?:^|[^\d])1[3-9]\d{9}(?:$|[^\d])/,
  /\+\d[\d\s().-]{6,}\d/,
  /(?:wechat|weixin|微信号|telegram|skype|whatsapp)(?:\s*(?:id|账号|帳號))?\s*[:=：]\s*[A-Z][A-Z0-9_.-]{4,}/i,
];

/** Parse and normalize the root-to-subplatform retrieval request envelope. */
export function parseRetrievalQuery(
  value: unknown,
): ParseResult<RetrievalQuery> {
  if (!isRecord(value)) return failure("retrieval query must be a JSON object");
  const unsupported = Object.keys(value).find(
    (key) =>
      !new Set([
        "protocol",
        "request_id",
        "scope",
        "input",
        "limit",
        "trace_id",
      ]).has(key),
  );
  if (unsupported)
    return failure(
      `retrieval query contains an unsupported field: ${unsupported}`,
    );
  if (value.protocol !== RETRIEVAL_PROTOCOL)
    return failure("protocol must be matchplane.retrieval/v1");
  if (!isUuid(value.request_id)) return failure("request_id must be a UUID");

  const scope = value.scope;
  if (!isRecord(scope))
    return failure("scope must contain tenant_id, domain_id and platform_path");
  const scopeKeys = new Set(["tenant_id", "domain_id", "platform_path"]);
  const unsupportedScope = Object.keys(scope).find(
    (key) => !scopeKeys.has(key),
  );
  if (unsupportedScope)
    return failure(`scope contains an unsupported field: ${unsupportedScope}`);
  if (!isUuid(scope.tenant_id))
    return failure("scope.tenant_id must be a UUID");
  if (!isUuid(scope.domain_id))
    return failure("scope.domain_id must be a UUID");
  const platformPath = normalizePlatformPath(scope.platform_path);
  if (!platformPath)
    return failure("scope.platform_path must be a normalized platform path");

  const input = value.input;
  if (!isRecord(input)) return failure("input must be an object");
  const inputKeys = new Set([
    "narrative",
    "requirements",
    "budget_min",
    "budget_max",
    "currency",
    "currency_scale",
  ]);
  const unsupportedInput = Object.keys(input).find(
    (key) => !inputKeys.has(key),
  );
  if (unsupportedInput)
    return failure(`input contains an unsupported field: ${unsupportedInput}`);
  if (
    typeof input.narrative !== "string" ||
    input.narrative.trim().length < 1 ||
    input.narrative.length > 10_000
  ) {
    return failure("input.narrative must contain 1..10000 characters");
  }
  if (!isRecord(input.requirements))
    return failure("input.requirements must be an object");
  if (!isWithinJsonBytes(input.requirements, MAX_REQUIREMENTS_BYTES))
    return failure("input.requirements is too large");
  const currencyError = validateCurrency(input.currency);
  if (currencyError) return failure(currencyError);
  const scaleError = validateCurrencyScale(input.currency_scale);
  if (scaleError) return failure(scaleError);
  if (
    input.budget_min !== undefined &&
    input.budget_min !== null &&
    !isBoundedString(input.budget_min, 200)
  )
    return failure("input.budget_min must be a string or null");
  if (
    input.budget_max !== undefined &&
    input.budget_max !== null &&
    !isBoundedString(input.budget_max, 200)
  )
    return failure("input.budget_max must be a string or null");
  if (
    !Number.isSafeInteger(value.limit) ||
    (value.limit as number) < 1 ||
    (value.limit as number) > 100
  )
    return failure("limit must be an integer between 1 and 100");
  if (
    value.trace_id !== undefined &&
    value.trace_id !== null &&
    !isBoundedString(value.trace_id, 200)
  )
    return failure("trace_id must be a string or null");

  return {
    ok: true,
    value: {
      protocol: RETRIEVAL_PROTOCOL,
      requestId: value.request_id,
      tenantId: scope.tenant_id,
      domainId: scope.domain_id,
      platformPath,
      input: {
        narrative: input.narrative.trim(),
        requirements: input.requirements,
        ...(input.budget_min === undefined
          ? {}
          : { budgetMin: input.budget_min as string | null }),
        ...(input.budget_max === undefined
          ? {}
          : { budgetMax: input.budget_max as string | null }),
        ...(input.currency === undefined
          ? {}
          : { currency: input.currency as string | null }),
        ...(input.currency_scale === undefined
          ? {}
          : { currencyScale: input.currency_scale as number | null }),
      },
      limit: value.limit as number,
      ...(value.trace_id === undefined
        ? {}
        : { traceId: value.trace_id as string | null }),
    },
  };
}

/** Validate an untrusted provider response against the stable retrieval result ABI. */
export function parseRetrievalResult(
  value: unknown,
  requestId: string,
  limit: number,
): ParseResult<RetrievalResult> {
  if (!isRecord(value))
    return failure("retrieval provider result must be a JSON object");
  const unsupported = Object.keys(value).find(
    (key) =>
      !new Set([
        "protocol",
        "request_id",
        "provider",
        "candidates",
        "degraded",
        "generated_at",
      ]).has(key),
  );
  if (unsupported)
    return failure(
      `retrieval provider result contains an unsupported field: ${unsupported}`,
    );
  if (value.protocol !== RETRIEVAL_PROTOCOL)
    return failure("retrieval provider returned an unsupported protocol");
  if (value.request_id !== requestId)
    return failure("retrieval provider request_id does not match");
  const provider = value.provider;
  if (!isRecord(provider))
    return failure("retrieval provider metadata is required");
  if (
    !isBoundedString(provider.id, 128) ||
    !TOOL_NAME_PATTERN.test(provider.id)
  )
    return failure("retrieval provider id is invalid");
  if (!isBoundedString(provider.version, 128))
    return failure("retrieval provider version is invalid");
  if (
    provider.model !== undefined &&
    provider.model !== null &&
    !isBoundedString(provider.model, 200)
  )
    return failure("retrieval provider model is invalid");
  if (
    !Array.isArray(value.candidates) ||
    value.candidates.length > Math.min(100, limit)
  )
    return failure("retrieval candidates exceed the requested limit");
  const candidates: RetrievalCandidate[] = [];
  for (const [index, candidate] of value.candidates.entries()) {
    const parsed = parseCandidate(candidate, index);
    if (!parsed.ok) return parsed;
    candidates.push(parsed.value);
  }
  if (typeof value.degraded !== "boolean")
    return failure("retrieval degraded must be boolean");
  if (
    value.generated_at !== undefined &&
    value.generated_at !== null &&
    (!isBoundedString(value.generated_at, 80) ||
      !Number.isFinite(Date.parse(value.generated_at)))
  ) {
    return failure("generated_at must be a valid date-time or null");
  }
  return {
    ok: true,
    value: {
      protocol: RETRIEVAL_PROTOCOL,
      requestId,
      provider: {
        id: provider.id,
        version: provider.version,
        ...(provider.model === undefined
          ? {}
          : { model: provider.model as string | null }),
      },
      candidates,
      degraded: value.degraded,
      ...(value.generated_at === undefined
        ? {}
        : { generatedAt: value.generated_at as string | null }),
    },
  };
}

/** Extract structured content from either JSON-RPC or streamable-HTTP MCP responses. */
export function extractMcpRetrievalResult(
  payload: Record<string, unknown>,
): ParseResult<Record<string, unknown>> {
  if (isRecord(payload.error))
    return failure("retrieval provider returned an MCP error");
  const result = isRecord(payload.result) ? payload.result : payload;
  if (result.isError === true)
    return failure("retrieval provider reported a tool error");
  if (isRecord(result.structuredContent))
    return { ok: true, value: result.structuredContent };
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (
        !isRecord(item) ||
        item.type !== "text" ||
        typeof item.text !== "string"
      )
        continue;
      try {
        const parsed = JSON.parse(item.text) as unknown;
        if (isRecord(parsed)) return { ok: true, value: parsed };
      } catch {
        // Try the next content block; MCP servers may include human-readable text first.
      }
    }
  }
  return failure("retrieval provider did not return structured JSON content");
}

function parseCandidate(
  value: unknown,
  index: number,
): ParseResult<RetrievalCandidate> {
  if (!isRecord(value))
    return failure(`retrieval candidate ${index} must be an object`);
  const unsupported = Object.keys(value).find(
    (key) =>
      !new Set([
        "asset_id",
        "offer_id",
        "display_name",
        "attributes",
        "terms",
        "score",
        "reasons",
        "risks",
        "metadata",
      ]).has(key),
  );
  if (unsupported)
    return failure(
      `retrieval candidate contains an unsupported field: ${unsupported}`,
    );
  if (value.asset_id === undefined && value.offer_id === undefined) {
    return failure(
      `retrieval candidate ${index} must include asset_id or offer_id`,
    );
  }
  if (value.asset_id !== undefined && !isUuid(value.asset_id))
    return failure(`retrieval candidate ${index} asset_id must be a UUID`);
  if (value.offer_id !== undefined && !isUuid(value.offer_id))
    return failure(`retrieval candidate ${index} offer_id must be a UUID`);
  if (
    value.display_name !== undefined &&
    !isBoundedString(value.display_name, 500)
  )
    return failure(`retrieval candidate ${index} display_name is invalid`);
  if (
    typeof value.score !== "number" ||
    !Number.isFinite(value.score) ||
    value.score < -1 ||
    value.score > 1
  )
    return failure(`retrieval candidate ${index} score is invalid`);
  if (
    !Array.isArray(value.reasons) ||
    value.reasons.length > 32 ||
    value.reasons.some(
      (reason) => !isBoundedString(reason, 500) || reason.trim().length === 0,
    )
  )
    return failure(`retrieval candidate ${index} reasons are invalid`);
  if (
    value.risks !== undefined &&
    (!Array.isArray(value.risks) ||
      value.risks.length > 32 ||
      value.risks.some(
        (risk) => !isBoundedString(risk, 500) || risk.trim().length === 0,
      ))
  )
    return failure(`retrieval candidate ${index} risks are invalid`);
  for (const field of ["attributes", "terms"] as const) {
    if (
      value[field] !== undefined &&
      (!isRecord(value[field]) ||
        !isWithinJsonBytes(value[field], MAX_METADATA_BYTES))
    ) {
      return failure(`retrieval candidate ${index} ${field} is invalid`);
    }
  }
  if (
    value.metadata !== undefined &&
    (!isRecord(value.metadata) ||
      !isWithinJsonBytes(value.metadata, MAX_METADATA_BYTES))
  )
    return failure(`retrieval candidate ${index} metadata is invalid`);
  if (containsContactMaterial(value)) {
    return failure(
      `retrieval candidate ${index} contains contact material; use the consent-gated introduction flow`,
    );
  }
  return {
    ok: true,
    value: {
      ...(value.asset_id === undefined ? {} : { assetId: value.asset_id }),
      ...(value.offer_id === undefined ? {} : { offerId: value.offer_id }),
      ...(value.display_name === undefined
        ? {}
        : { displayName: value.display_name }),
      ...(value.attributes === undefined
        ? {}
        : { attributes: value.attributes as Record<string, unknown> }),
      ...(value.terms === undefined
        ? {}
        : { terms: value.terms as Record<string, unknown> }),
      score: value.score,
      reasons: value.reasons as string[],
      ...(value.risks === undefined ? {} : { risks: value.risks as string[] }),
      ...(value.metadata === undefined
        ? {}
        : { metadata: value.metadata as Record<string, unknown> }),
    },
  };
}

function containsContactMaterial(value: unknown): boolean {
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length > 0) {
    if (++visited > 4_096) return true;
    const current = pending.pop();
    if (typeof current === "string") {
      if (CONTACT_VALUE_PATTERNS.some((pattern) => pattern.test(current))) {
        return true;
      }
      continue;
    }
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (!isRecord(current)) continue;
    for (const [rawKey, nested] of Object.entries(current)) {
      const key = rawKey
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
      if (
        CONTACT_FIELD_NAMES.has(key) ||
        key.startsWith("contact_") ||
        key.endsWith("_contact") ||
        /^(?:seller|merchant|buyer|owner|provider|supplier|support)_(?:phone|email)$/.test(
          key,
        )
      ) {
        return true;
      }
      pending.push(nested);
    }
  }
  return false;
}

function validateCurrency(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && /^[A-Z]{3}$/.test(value)
    ? null
    : "input.currency must be an ISO-4217 code or null";
}

function validateCurrencyScale(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 18
    ? null
    : "input.currency_scale must be an integer between 0 and 18 or null";
}

function isWithinJsonBytes(value: unknown, maximum: number): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= maximum;
  } catch {
    return false;
  }
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" && value.length >= 1 && value.length <= maximum
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function failure<T = never>(error: string): ParseResult<T> {
  return { ok: false, error };
}

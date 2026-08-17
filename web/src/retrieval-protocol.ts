import { normalizePlatformPath } from "./platform-agent-handoff";

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
  assetId: string;
  /** Optional canonical offer reference used by the introduction API. */
  offerId?: string;
  /** Public projection fields are optional so a provider may keep its catalogue private. */
  displayName?: string;
  attributes?: Record<string, unknown>;
  terms?: Record<string, unknown>;
  score: number;
  reasons: string[];
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

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOOL_NAME_PATTERN = /^[a-z0-9][a-z0-9._:-]{1,127}$/;
const MAX_REQUIREMENTS_BYTES = 32 * 1024;
const MAX_METADATA_BYTES = 32 * 1024;

/** Parse and normalize the root-to-subplatform retrieval request envelope. */
export function parseRetrievalQuery(value: unknown): ParseResult<RetrievalQuery> {
  if (!isRecord(value)) return failure("retrieval query must be a JSON object");
  const unsupported = Object.keys(value).find((key) => !new Set(["protocol", "request_id", "scope", "input", "limit", "trace_id"]).has(key));
  if (unsupported) return failure(`retrieval query contains an unsupported field: ${unsupported}`);
  if (value.protocol !== RETRIEVAL_PROTOCOL) return failure("protocol must be matchplane.retrieval/v1");
  if (!isUuid(value.request_id)) return failure("request_id must be a UUID");

  const scope = value.scope;
  if (!isRecord(scope)) return failure("scope must contain tenant_id, domain_id and platform_path");
  const scopeKeys = new Set(["tenant_id", "domain_id", "platform_path"]);
  const unsupportedScope = Object.keys(scope).find((key) => !scopeKeys.has(key));
  if (unsupportedScope) return failure(`scope contains an unsupported field: ${unsupportedScope}`);
  if (!isUuid(scope.tenant_id)) return failure("scope.tenant_id must be a UUID");
  if (!isUuid(scope.domain_id)) return failure("scope.domain_id must be a UUID");
  const platformPath = normalizePlatformPath(scope.platform_path);
  if (!platformPath) return failure("scope.platform_path must be a normalized platform path");

  const input = value.input;
  if (!isRecord(input)) return failure("input must be an object");
  const inputKeys = new Set(["narrative", "requirements", "budget_min", "budget_max", "currency", "currency_scale"]);
  const unsupportedInput = Object.keys(input).find((key) => !inputKeys.has(key));
  if (unsupportedInput) return failure(`input contains an unsupported field: ${unsupportedInput}`);
  if (typeof input.narrative !== "string" || input.narrative.trim().length < 1 || input.narrative.length > 10_000) {
    return failure("input.narrative must contain 1..10000 characters");
  }
  if (!isRecord(input.requirements)) return failure("input.requirements must be an object");
  if (!isWithinJsonBytes(input.requirements, MAX_REQUIREMENTS_BYTES)) return failure("input.requirements is too large");
  const currencyError = validateCurrency(input.currency);
  if (currencyError) return failure(currencyError);
  const scaleError = validateCurrencyScale(input.currency_scale);
  if (scaleError) return failure(scaleError);
  if (input.budget_min !== undefined && input.budget_min !== null && !isBoundedString(input.budget_min, 200)) return failure("input.budget_min must be a string or null");
  if (input.budget_max !== undefined && input.budget_max !== null && !isBoundedString(input.budget_max, 200)) return failure("input.budget_max must be a string or null");
  if (!Number.isSafeInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 100) return failure("limit must be an integer between 1 and 100");
  if (value.trace_id !== undefined && value.trace_id !== null && !isBoundedString(value.trace_id, 200)) return failure("trace_id must be a string or null");

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
        ...(input.budget_min === undefined ? {} : { budgetMin: input.budget_min as string | null }),
        ...(input.budget_max === undefined ? {} : { budgetMax: input.budget_max as string | null }),
        ...(input.currency === undefined ? {} : { currency: input.currency as string | null }),
        ...(input.currency_scale === undefined ? {} : { currencyScale: input.currency_scale as number | null }),
      },
      limit: value.limit,
      ...(value.trace_id === undefined ? {} : { traceId: value.trace_id as string | null }),
    },
  };
}

/** Validate an untrusted provider response against the stable retrieval result ABI. */
export function parseRetrievalResult(value: unknown, requestId: string, limit: number): ParseResult<RetrievalResult> {
  if (!isRecord(value)) return failure("retrieval provider result must be a JSON object");
  const unsupported = Object.keys(value).find((key) => !new Set(["protocol", "request_id", "provider", "candidates", "degraded", "generated_at"]).has(key));
  if (unsupported) return failure(`retrieval provider result contains an unsupported field: ${unsupported}`);
  if (value.protocol !== RETRIEVAL_PROTOCOL) return failure("retrieval provider returned an unsupported protocol");
  if (value.request_id !== requestId) return failure("retrieval provider request_id does not match");
  const provider = value.provider;
  if (!isRecord(provider)) return failure("retrieval provider metadata is required");
  if (!isBoundedString(provider.id, 128) || !TOOL_NAME_PATTERN.test(provider.id)) return failure("retrieval provider id is invalid");
  if (!isBoundedString(provider.version, 128)) return failure("retrieval provider version is invalid");
  if (provider.model !== undefined && provider.model !== null && !isBoundedString(provider.model, 200)) return failure("retrieval provider model is invalid");
  if (!Array.isArray(value.candidates) || value.candidates.length > Math.min(100, limit)) return failure("retrieval candidates exceed the requested limit");
  const candidates: RetrievalCandidate[] = [];
  for (const [index, candidate] of value.candidates.entries()) {
    const parsed = parseCandidate(candidate, index);
    if (!parsed.ok) return parsed;
    candidates.push(parsed.value);
  }
  if (typeof value.degraded !== "boolean") return failure("retrieval degraded must be boolean");
  if (value.generated_at !== undefined && value.generated_at !== null
    && (!isBoundedString(value.generated_at, 80) || !Number.isFinite(Date.parse(value.generated_at)))) {
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
        ...(provider.model === undefined ? {} : { model: provider.model as string | null }),
      },
      candidates,
      degraded: value.degraded,
      ...(value.generated_at === undefined ? {} : { generatedAt: value.generated_at as string | null }),
    },
  };
}

/** Extract structured content from either JSON-RPC or streamable-HTTP MCP responses. */
export function extractMcpRetrievalResult(payload: Record<string, unknown>): ParseResult<Record<string, unknown>> {
  if (isRecord(payload.error)) return failure("retrieval provider returned an MCP error");
  const result = isRecord(payload.result) ? payload.result : payload;
  if (result.isError === true) return failure("retrieval provider reported a tool error");
  if (isRecord(result.structuredContent)) return { ok: true, value: result.structuredContent };
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
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

function parseCandidate(value: unknown, index: number): ParseResult<RetrievalCandidate> {
  if (!isRecord(value)) return failure(`retrieval candidate ${index} must be an object`);
  const unsupported = Object.keys(value).find((key) => !new Set(["asset_id", "offer_id", "display_name", "attributes", "terms", "score", "reasons", "metadata"]).has(key));
  if (unsupported) return failure(`retrieval candidate contains an unsupported field: ${unsupported}`);
  if (!isUuid(value.asset_id)) return failure(`retrieval candidate ${index} asset_id must be a UUID`);
  if (value.offer_id !== undefined && !isUuid(value.offer_id)) return failure(`retrieval candidate ${index} offer_id must be a UUID`);
  if (value.display_name !== undefined && !isBoundedString(value.display_name, 500)) return failure(`retrieval candidate ${index} display_name is invalid`);
  if (typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < -1 || value.score > 1) return failure(`retrieval candidate ${index} score is invalid`);
  if (!Array.isArray(value.reasons) || value.reasons.length > 32 || value.reasons.some((reason) => !isBoundedString(reason, 500) || reason.trim().length === 0)) return failure(`retrieval candidate ${index} reasons are invalid`);
  for (const field of ["attributes", "terms"] as const) {
    if (value[field] !== undefined && (!isRecord(value[field]) || !isWithinJsonBytes(value[field], MAX_METADATA_BYTES))) {
      return failure(`retrieval candidate ${index} ${field} is invalid`);
    }
  }
  if (value.metadata !== undefined && (!isRecord(value.metadata) || !isWithinJsonBytes(value.metadata, MAX_METADATA_BYTES))) return failure(`retrieval candidate ${index} metadata is invalid`);
  return {
    ok: true,
    value: {
      assetId: value.asset_id,
      ...(value.offer_id === undefined ? {} : { offerId: value.offer_id }),
      ...(value.display_name === undefined ? {} : { displayName: value.display_name }),
      ...(value.attributes === undefined ? {} : { attributes: value.attributes }),
      ...(value.terms === undefined ? {} : { terms: value.terms }),
      score: value.score,
      reasons: value.reasons,
      ...(value.metadata === undefined ? {} : { metadata: value.metadata }),
    },
  };
}

function validateCurrency(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && /^[A-Z]{3}$/.test(value) ? null : "input.currency must be an ISO-4217 code or null";
}

function validateCurrencyScale(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 18
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
  return typeof value === "string" && value.length >= 1 && value.length <= maximum;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function failure<T = never>(error: string): ParseResult<T> {
  return { ok: false, error };
}

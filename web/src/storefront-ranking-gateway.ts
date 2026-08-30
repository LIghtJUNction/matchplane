import {
  readJsonResponseBody,
  ResponseBodyTooLargeError,
} from "./lib/body-limit";
import { loadInternalBearer } from "./lib/internal-auth";
import {
  type GatewayLexicalRankedCandidate,
  LEXICAL_RANK_ADVISORY,
  LEXICAL_RANK_TOTAL_DEADLINE_MS,
  MAX_LEXICAL_RANK_BATCH_CANDIDATES,
  MAX_LEXICAL_RANK_CONCURRENCY,
  MAX_LEXICAL_RANK_DESCRIPTION_CHARACTERS,
  MAX_LEXICAL_RANK_INTENT_REASONS,
  MAX_LEXICAL_RANK_LABEL_CHARACTERS,
  MAX_LEXICAL_RANK_NAME_CHARACTERS,
  MAX_LEXICAL_RANK_NARRATIVE_CHARACTERS,
  MAX_LEXICAL_RANK_OVERLAP_COUNT,
  MAX_LEXICAL_RANK_OVERLAP_LABELS,
  MAX_LEXICAL_RANK_REASON_CHARACTERS,
  MAX_LEXICAL_RANK_REQUEST_BYTES,
  MAX_LEXICAL_RANK_RESPONSE_BYTES,
  MAX_LEXICAL_RANK_TOTAL_CANDIDATES,
  type PreparedLexicalRankCandidate,
  PublicStorefrontRankingError,
} from "./storefront-ranking-contract";

export * from "./storefront-ranking-contract";

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8080";
const LEXICAL_RANK_PATH = "/v1/internal/matching/lexical-rank";

interface LexicalRankRequestCandidate {
  display_name: string;
  description: string;
  eligible: boolean;
  intent_boost: number;
  intent_reasons: string[];
}

export interface LexicalRankBatch {
  body: string;
  candidateIndexes: number[];
  candidates: PreparedLexicalRankCandidate[];
}
export interface LexicalRankGatewayOptions {
  deadlineMs?: number;
  endpoint?: string;
  fetchImplementation?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  loadBearer?: () => Promise<string>;
}
/** Split every candidate by both the Rust count cap and the stricter Web byte cap. */
export function buildLexicalRankBatches(
  narrative: string,
  candidates: PreparedLexicalRankCandidate[],
  maximumBytes = MAX_LEXICAL_RANK_REQUEST_BYTES,
): LexicalRankBatch[] {
  assertRequestInput(narrative, candidates);
  const batches: LexicalRankBatch[] = [];
  let currentCandidates: PreparedLexicalRankCandidate[] = [];
  let currentIndexes: number[] = [];
  const flush = (): void => {
    if (!currentCandidates.length) return;
    batches.push(
      serializeBatch(
        narrative,
        currentCandidates,
        currentIndexes,
        maximumBytes,
      ),
    );
    currentCandidates = [];
    currentIndexes = [];
  };
  for (const [candidateIndex, candidate] of candidates.entries()) {
    if (currentCandidates.length === MAX_LEXICAL_RANK_BATCH_CANDIDATES) flush();
    const proposedCandidates = [...currentCandidates, candidate];
    const proposedIndexes = [...currentIndexes, candidateIndex];
    const proposed = serializeBatch(
      narrative,
      proposedCandidates,
      proposedIndexes,
      Number.POSITIVE_INFINITY,
    );
    if (utf8Bytes(proposed.body) <= maximumBytes) {
      currentCandidates = proposedCandidates;
      currentIndexes = proposedIndexes;
      continue;
    }
    flush();
    const single = serializeBatch(
      narrative,
      [candidate],
      [candidateIndex],
      Number.POSITIVE_INFINITY,
    );
    const actualBytes = utf8Bytes(single.body);
    if (actualBytes > maximumBytes) {
      throw new PublicStorefrontRankingError("request_too_large", {
        candidateIndex,
        actualBytes,
        maximumBytes,
      });
    }
    currentCandidates = [candidate];
    currentIndexes = [candidateIndex];
  }
  flush();
  return batches;
}
/** Call the internal Rust kernel for every batch, with no TypeScript ranking fallback. */
export async function rankWithRustLexicalGateway(
  narrative: string,
  candidates: PreparedLexicalRankCandidate[],
  options: LexicalRankGatewayOptions = {},
): Promise<GatewayLexicalRankedCandidate[]> {
  const batches = buildLexicalRankBatches(narrative, candidates);
  if (!batches.length) return [];
  const endpoint = configuredEndpoint(options.endpoint);
  const bearer = await configuredBearer(options.loadBearer);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const controller = new AbortController();
  const deadlineMs = Math.max(
    1,
    Math.min(
      LEXICAL_RANK_TOTAL_DEADLINE_MS,
      options.deadlineMs ?? LEXICAL_RANK_TOTAL_DEADLINE_MS,
    ),
  );
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstFailure: PublicStorefrontRankingError | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      firstFailure ??= new PublicStorefrontRankingError("timeout");
      controller.abort();
      reject(firstFailure);
    }, deadlineMs);
  });
  let nextBatch = 0;
  const ranked: GatewayLexicalRankedCandidate[] = [];
  const worker = async (): Promise<void> => {
    while (!firstFailure) {
      const batchIndex = nextBatch++;
      const batch = batches[batchIndex];
      if (!batch) return;
      try {
        ranked.push(
          ...(await executeBatch({
            batch,
            batchIndex,
            bearer,
            endpoint,
            fetchImplementation,
            signal: controller.signal,
          })),
        );
      } catch (error) {
        firstFailure ??= normalizeFailure(error, batchIndex, timedOut);
        controller.abort();
        throw firstFailure;
      }
    }
  };
  const requests = Promise.all(
    Array.from(
      { length: Math.min(MAX_LEXICAL_RANK_CONCURRENCY, batches.length) },
      () => worker(),
    ),
  );
  try {
    await Promise.race([requests, deadline]);
    return ranked;
  } catch (error) {
    controller.abort();
    throw normalizeFailure(error, undefined, timedOut);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function executeBatch(input: {
  batch: LexicalRankBatch;
  batchIndex: number;
  bearer: string;
  endpoint: string;
  fetchImplementation: NonNullable<
    LexicalRankGatewayOptions["fetchImplementation"]
  >;
  signal: AbortSignal;
}): Promise<GatewayLexicalRankedCandidate[]> {
  let response: Response;
  try {
    response = await input.fetchImplementation(input.endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.bearer}`,
        "content-type": "application/json",
      },
      body: input.batch.body,
      cache: "no-store",
      signal: input.signal,
    });
  } catch {
    throw new PublicStorefrontRankingError("network", {
      batchIndex: input.batchIndex,
    });
  }
  if (!response.ok) {
    throw new PublicStorefrontRankingError("upstream_http", {
      batchIndex: input.batchIndex,
      status: response.status,
    });
  }
  if (!isJsonContentType(response.headers.get("content-type"))) {
    throw malformed(input.batchIndex);
  }
  let payload: unknown;
  try {
    payload = await readJsonResponseBody(
      response,
      MAX_LEXICAL_RANK_RESPONSE_BYTES,
    );
  } catch (error) {
    throw new PublicStorefrontRankingError(
      error instanceof ResponseBodyTooLargeError
        ? "response_too_large"
        : "malformed_response",
      { batchIndex: input.batchIndex },
    );
  }
  return validateResponse(payload, input.batch, input.batchIndex);
}

function validateResponse(
  payload: unknown,
  batch: LexicalRankBatch,
  batchIndex: number,
): GatewayLexicalRankedCandidate[] {
  const response = record(payload);
  if (
    !hasExactKeys(response, ["schema_version", "ranked"]) ||
    response.schema_version !== 1 ||
    !Array.isArray(response.ranked)
  ) {
    throw malformed(batchIndex);
  }
  if (response.ranked.length > batch.candidates.length) {
    throw malformed(batchIndex);
  }

  const seen = new Set<number>();
  return response.ranked.map((value) => {
    const row = record(value);
    if (
      !hasExactKeys(row, [
        "candidate_index",
        "score",
        "overlap_count",
        "overlap_labels",
        "advisory",
      ])
    ) {
      throw malformed(batchIndex);
    }
    const candidateIndex = row.candidate_index;
    const score = row.score;
    const overlapCount = row.overlap_count;
    const overlapLabels = row.overlap_labels;
    if (
      !Number.isInteger(candidateIndex) ||
      (candidateIndex as number) < 0 ||
      (candidateIndex as number) >= batch.candidates.length ||
      seen.has(candidateIndex as number) ||
      !batch.candidates[candidateIndex as number]?.eligible ||
      typeof score !== "number" ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 0.99 ||
      !Number.isInteger(overlapCount) ||
      (overlapCount as number) < 0 ||
      (overlapCount as number) > MAX_LEXICAL_RANK_OVERLAP_COUNT ||
      !validOverlapLabels(overlapLabels) ||
      (overlapCount as number) < overlapLabels.length ||
      row.advisory !== LEXICAL_RANK_ADVISORY
    ) {
      throw malformed(batchIndex);
    }
    seen.add(candidateIndex as number);
    return {
      candidateIndex: batch.candidateIndexes[candidateIndex as number]!,
      score,
      overlapCount: overlapCount as number,
      overlapLabels,
      advisory: LEXICAL_RANK_ADVISORY,
    };
  });
}

function serializeBatch(
  narrative: string,
  candidates: PreparedLexicalRankCandidate[],
  candidateIndexes: number[],
  maximumBytes: number,
): LexicalRankBatch {
  const body = JSON.stringify({
    narrative,
    candidates: candidates.map(toRequestCandidate),
  });
  const actualBytes = utf8Bytes(body);
  if (actualBytes > maximumBytes) {
    throw new PublicStorefrontRankingError("request_too_large", {
      candidateIndex:
        candidateIndexes.length === 1 ? candidateIndexes[0] : undefined,
      actualBytes,
      maximumBytes,
    });
  }
  return { body, candidateIndexes, candidates };
}

function toRequestCandidate(
  candidate: PreparedLexicalRankCandidate,
): LexicalRankRequestCandidate {
  return {
    display_name: candidate.displayName,
    description: candidate.description,
    eligible: candidate.eligible,
    intent_boost: candidate.intentBoost,
    intent_reasons: candidate.intentReasons,
  };
}

function assertRequestInput(
  narrative: string,
  candidates: PreparedLexicalRankCandidate[],
): void {
  if (
    typeof narrative !== "string" ||
    scalarLength(narrative) > MAX_LEXICAL_RANK_NARRATIVE_CHARACTERS ||
    !Array.isArray(candidates) ||
    candidates.length > MAX_LEXICAL_RANK_TOTAL_CANDIDATES
  ) {
    throw new PublicStorefrontRankingError("request_too_large");
  }
  for (const [candidateIndex, candidate] of candidates.entries()) {
    if (
      typeof candidate.displayName !== "string" ||
      scalarLength(candidate.displayName) > MAX_LEXICAL_RANK_NAME_CHARACTERS ||
      typeof candidate.description !== "string" ||
      scalarLength(candidate.description) >
        MAX_LEXICAL_RANK_DESCRIPTION_CHARACTERS ||
      typeof candidate.eligible !== "boolean" ||
      typeof candidate.intentBoost !== "number" ||
      !Number.isFinite(candidate.intentBoost) ||
      candidate.intentBoost < 0 ||
      candidate.intentBoost > 0.7 ||
      !Array.isArray(candidate.intentReasons) ||
      candidate.intentReasons.length > MAX_LEXICAL_RANK_INTENT_REASONS ||
      candidate.intentReasons.some(
        (reason) =>
          typeof reason !== "string" ||
          scalarLength(reason) > MAX_LEXICAL_RANK_REASON_CHARACTERS,
      )
    ) {
      throw new PublicStorefrontRankingError("request_too_large", {
        candidateIndex,
      });
    }
  }
}

function validOverlapLabels(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_LEXICAL_RANK_OVERLAP_LABELS) {
    return false;
  }
  const seen = new Set<string>();
  for (const label of value) {
    if (
      typeof label !== "string" ||
      !label ||
      label.trim() !== label ||
      /[\u0000-\u001f\u007f]/.test(label) ||
      scalarLength(label) > MAX_LEXICAL_RANK_LABEL_CHARACTERS ||
      seen.has(label)
    ) {
      return false;
    }
    seen.add(label);
  }
  return true;
}

function isJsonContentType(value: string | null): boolean {
  return (
    value?.split(";", 1)[0]?.trim().toLocaleLowerCase() === "application/json"
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function configuredEndpoint(override: string | undefined): string {
  const configured = (
    override ??
    process.env.MATCHPLANE_GATEWAY_INTERNAL_URL ??
    DEFAULT_GATEWAY_URL
  ).trim();
  try {
    const endpoint = new URL(configured);
    if (
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    ) {
      throw new Error("unsafe endpoint");
    }
    endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}${LEXICAL_RANK_PATH}`;
    return endpoint.toString();
  } catch {
    throw new PublicStorefrontRankingError("configuration");
  }
}

async function configuredBearer(
  override: LexicalRankGatewayOptions["loadBearer"],
): Promise<string> {
  let bearer: string;
  try {
    bearer = await (override
      ? override()
      : loadInternalBearer(
          "MATCHPLANE_GATEWAY_ADMIN_TOKEN",
          "MATCHPLANE_GATEWAY_ADMIN_TOKEN_FILE",
        ));
  } catch {
    throw new PublicStorefrontRankingError("configuration");
  }
  if (
    !bearer ||
    bearer.length > 8_192 ||
    /[\u0000-\u001f\u007f]/.test(bearer)
  ) {
    throw new PublicStorefrontRankingError("configuration");
  }
  return bearer;
}

function normalizeFailure(
  error: unknown,
  batchIndex: number | undefined,
  timedOut: boolean,
): PublicStorefrontRankingError {
  if (timedOut) return new PublicStorefrontRankingError("timeout");
  if (error instanceof PublicStorefrontRankingError) return error;
  return new PublicStorefrontRankingError("network", { batchIndex });
}

function malformed(batchIndex: number): PublicStorefrontRankingError {
  return new PublicStorefrontRankingError("malformed_response", { batchIndex });
}

function scalarLength(value: string): number {
  return [...value].length;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

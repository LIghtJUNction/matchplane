export const MAX_LEXICAL_RANK_BATCH_CANDIDATES = 64;
export const MAX_LEXICAL_RANK_TOTAL_CANDIDATES = 2_000;
export const MAX_LEXICAL_RANK_REQUEST_BYTES = 700 * 1024;
export const MAX_LEXICAL_RANK_RESPONSE_BYTES = 700 * 1024;
export const MAX_LEXICAL_RANK_NARRATIVE_CHARACTERS = 8_000;
export const MAX_LEXICAL_RANK_NAME_CHARACTERS = 512;
export const MAX_LEXICAL_RANK_DESCRIPTION_CHARACTERS = 8_000;
export const MAX_LEXICAL_RANK_INTENT_REASONS = 8;
export const MAX_LEXICAL_RANK_REASON_CHARACTERS = 500;
export const MAX_LEXICAL_RANK_OVERLAP_COUNT = 512;
export const MAX_LEXICAL_RANK_OVERLAP_LABELS = 8;
export const MAX_LEXICAL_RANK_LABEL_CHARACTERS = 500;
export const MAX_LEXICAL_RANK_CONCURRENCY = 4;
export const LEXICAL_RANK_ADVISORY =
  "Matching results are recommendations only; they grant no authorization, contact consent, payment authority, contractual acceptance, or other right.";
/** Four seconds leaves route headroom; all batch requests share this wall-clock deadline. */
export const LEXICAL_RANK_TOTAL_DEADLINE_MS = 4_000;

export interface PreparedLexicalRankCandidate {
  displayName: string;
  description: string;
  eligible: boolean;
  intentBoost: number;
  intentReasons: string[];
}

export interface GatewayLexicalRankedCandidate {
  candidateIndex: number;
  score: number;
  overlapCount: number;
  overlapLabels: string[];
  advisory: string;
}

export type PublicStorefrontRankingFailureKind =
  | "configuration"
  | "request_too_large"
  | "timeout"
  | "network"
  | "upstream_http"
  | "response_too_large"
  | "malformed_response";

/** A bounded failure that never includes a token, narrative, URL, or candidate content. */
export class PublicStorefrontRankingError extends Error {
  readonly code = "public_storefront_ranking_failed";
  readonly batchIndex: number | undefined;
  readonly candidateIndex: number | undefined;
  readonly actualBytes: number | undefined;
  readonly maximumBytes: number | undefined;
  readonly status: number | undefined;

  constructor(
    readonly kind: PublicStorefrontRankingFailureKind,
    options: {
      batchIndex?: number;
      candidateIndex?: number;
      actualBytes?: number;
      maximumBytes?: number;
      status?: number;
    } = {},
  ) {
    super(`public storefront Rust ranking failed: ${kind}`);
    this.name = "PublicStorefrontRankingError";
    this.batchIndex = options.batchIndex;
    this.candidateIndex = options.candidateIndex;
    this.actualBytes = options.actualBytes;
    this.maximumBytes = options.maximumBytes;
    this.status = options.status;
  }
}

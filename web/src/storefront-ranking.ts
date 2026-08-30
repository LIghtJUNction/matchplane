import {
  MAX_LEXICAL_RANK_DESCRIPTION_CHARACTERS,
  MAX_LEXICAL_RANK_INTENT_REASONS,
  MAX_LEXICAL_RANK_NAME_CHARACTERS,
  MAX_LEXICAL_RANK_REASON_CHARACTERS,
  type GatewayLexicalRankedCandidate,
  type PreparedLexicalRankCandidate,
  PublicStorefrontRankingError,
} from "./storefront-ranking-contract";
import { rankWithRustLexicalGateway } from "./storefront-ranking-gateway";
import {
  evaluateShoppingIntent,
  type PublicShoppingIntent,
} from "./shopping-intent";
import {
  boundedMatchReasons,
  isSafePublicAttributeKey,
} from "./storefront-ranking-shared";

export {
  boundedMatchReasons,
  MAX_PUBLIC_MATCH_REASON_CHARACTERS,
  MAX_PUBLIC_MATCH_REASONS,
} from "./storefront-ranking-shared";

export type PublicOfferSearchSort =
  | "relevance"
  | "latest"
  | "popularity"
  | "price_asc"
  | "price_desc";

export interface PublicStorefrontRankingCandidate<Row> {
  row: Row;
  displayName: string;
  attributes: Record<string, unknown>;
  terms: Record<string, unknown>;
}

export interface RankedPublicStorefrontCandidate<Row>
  extends PublicStorefrontRankingCandidate<Row> {
  score: number | undefined;
  overlapCount: number;
  overlapLabels: string[];
  intentReasons: string[];
  originalIndex: number;
}

export interface PublicStorefrontSortCandidate {
  publishedAt: string | null;
  likeTotal?: string;
  terms: unknown;
}

type RustLexicalRanker = (
  narrative: string,
  candidates: PreparedLexicalRankCandidate[],
) => Promise<GatewayLexicalRankedCandidate[]>;

/**
 * Keep structured eligibility in Web, then delegate every real match claim to Rust.
 * Empty browse remains the existing unscored catalogue and loads no gateway token.
 */
export async function rankPublicStorefrontCandidates<Row>(
  candidates: PublicStorefrontRankingCandidate<Row>[],
  narrative: string,
  intent?: PublicShoppingIntent,
  rustRanker: RustLexicalRanker = rankWithRustLexicalGateway,
): Promise<RankedPublicStorefrontCandidate<Row>[]> {
  const prepared = candidates.map((candidate, originalIndex) => {
    const evaluation = evaluateShoppingIntent(
      candidate.attributes,
      candidate.terms,
      intent,
    );
    return {
      candidate,
      originalIndex,
      intentReasons: boundedMatchReasons(evaluation.reasons).slice(
        0,
        MAX_LEXICAL_RANK_INTENT_REASONS,
      ),
      request: {
        displayName: truncateScalars(
          candidate.displayName.trim(),
          MAX_LEXICAL_RANK_NAME_CHARACTERS,
        ),
        description: publicPrimitiveAttributeDescription(candidate.attributes),
        eligible: evaluation.eligible,
        intentBoost: evaluation.boost,
        intentReasons: boundedMatchReasons(evaluation.reasons).map((reason) =>
          truncateScalars(reason, MAX_LEXICAL_RANK_REASON_CHARACTERS),
        ),
      } satisfies PreparedLexicalRankCandidate,
    };
  });

  if (!hasPublicStorefrontRequestCriteria(narrative, intent)) {
    return prepared.map(({ candidate, originalIndex }) => ({
      ...candidate,
      score: undefined,
      overlapCount: 0,
      overlapLabels: [],
      intentReasons: [],
      originalIndex,
    }));
  }

  const rankedRows = await rustRanker(
    narrative,
    prepared.map(({ request }) => request),
  );
  return mergeRustRankedCandidates(prepared, rankedRows);
}

function hasPublicStorefrontRequestCriteria(
  narrative: string,
  intent: PublicShoppingIntent | undefined,
): boolean {
  return narrative.trim().length > 0 || hasStructuredIntentCriteria(intent);
}

/** Use only stable, canonical primitive values; nested/public-provider metadata is excluded. */
export function publicPrimitiveAttributeDescription(
  attributes: Record<string, unknown>,
): string {
  const values = Object.entries(attributes)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .flatMap(([key, value]): string[] => {
      if (!isSafePublicAttributeKey(key) || !isPrimitive(value)) return [];
      if (typeof value === "number" && !Number.isFinite(value)) return [];
      const normalized = String(value).trim();
      return normalized ? [normalized] : [];
    });
  return truncateScalars(
    values.join("\n"),
    MAX_LEXICAL_RANK_DESCRIPTION_CHARACTERS,
  );
}

export function comparePublicStorefrontOffers(
  left: PublicStorefrontSortCandidate,
  right: PublicStorefrontSortCandidate,
  sort: Exclude<PublicOfferSearchSort, "relevance">,
): number {
  if (sort === "latest") {
    return String(right.publishedAt ?? "").localeCompare(
      String(left.publishedAt ?? ""),
    );
  }
  if (sort === "popularity") {
    return compareBigInt(
      integerText(right.likeTotal),
      integerText(left.likeTotal),
    );
  }
  const direction = sort === "price_asc" ? 1 : -1;
  const leftPrice = publicPrice(left.terms);
  const rightPrice = publicPrice(right.terms);
  const currencyOrder = leftPrice.currency.localeCompare(rightPrice.currency);
  if (currencyOrder) return currencyOrder;
  const scale = Math.max(leftPrice.scale, rightPrice.scale);
  const leftAmount = leftPrice.amount * 10n ** BigInt(scale - leftPrice.scale);
  const rightAmount =
    rightPrice.amount * 10n ** BigInt(scale - rightPrice.scale);
  return direction * compareBigInt(leftAmount, rightAmount);
}

function mergeRustRankedCandidates<Row>(
  prepared: Array<{
    candidate: PublicStorefrontRankingCandidate<Row>;
    originalIndex: number;
    intentReasons: string[];
    request: PreparedLexicalRankCandidate;
  }>,
  rankedRows: GatewayLexicalRankedCandidate[],
): RankedPublicStorefrontCandidate<Row>[] {
  const seen = new Set<number>();
  const merged = rankedRows.map((ranked) => {
    const item = prepared[ranked.candidateIndex];
    if (!item || seen.has(ranked.candidateIndex) || !item.request.eligible) {
      throw new PublicStorefrontRankingError("malformed_response");
    }
    seen.add(ranked.candidateIndex);
    return {
      ...item.candidate,
      score: ranked.score,
      overlapCount: ranked.overlapCount,
      overlapLabels: ranked.overlapLabels,
      intentReasons: item.intentReasons,
      originalIndex: item.originalIndex,
    };
  });
  return merged.sort(
    (left, right) =>
      right.overlapCount - left.overlapCount ||
      (right.score ?? 0) - (left.score ?? 0) ||
      left.originalIndex - right.originalIndex,
  );
}

function hasStructuredIntentCriteria(
  intent: PublicShoppingIntent | undefined,
): boolean {
  return Boolean(intent?.budget) || Boolean(intent?.requirements.length);
}

function truncateScalars(value: string, maximum: number): string {
  return [...value].slice(0, maximum).join("");
}

function publicPrice(value: unknown): {
  currency: string;
  amount: bigint;
  scale: number;
} {
  const terms = record(value);
  const rawScale = Number(terms.currency_scale);
  return {
    currency: text(terms.currency),
    amount: integerText(terms.amount_minor),
    scale: Number.isInteger(rawScale) ? Math.max(0, Math.min(18, rawScale)) : 0,
  };
}

function integerText(value: unknown): bigint {
  const textValue = String(value ?? "");
  return /^\d+$/.test(textValue) ? BigInt(textValue) : 0n;
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

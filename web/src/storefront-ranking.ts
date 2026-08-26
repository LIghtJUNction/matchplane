import {
  evaluateShoppingIntent,
  type PublicShoppingIntent,
} from "./shopping-intent";

export const MAX_PUBLIC_MATCH_REASONS = 8;
export const MAX_PUBLIC_MATCH_REASON_CHARACTERS = 500;

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
  overlapLabels: string[];
  intentReasons: string[];
}

export interface PublicStorefrontSortCandidate {
  publishedAt: string | null;
  likeTotal?: string;
  terms: unknown;
}

/** Rank only positive, explainable request matches; an empty browse carries no match claim. */
export function rankPublicStorefrontCandidates<Row>(
  candidates: PublicStorefrontRankingCandidate<Row>[],
  narrative: string,
  intent?: PublicShoppingIntent,
): RankedPublicStorefrontCandidate<Row>[] {
  const queryTokens = tokenize(narrative);
  const hasRequestCriteria =
    narrative.trim().length > 0 || hasStructuredIntentCriteria(intent);
  return candidates
    .flatMap((candidate, index) => {
      const evaluation = evaluateShoppingIntent(
        candidate.attributes,
        candidate.terms,
        intent,
      );
      if (!evaluation.eligible) return [];
      const publicAttributeValues = Object.values(candidate.attributes)
        .filter(isPrimitive)
        .map((value) => String(value));
      const haystackTokens = new Set(
        tokenize([candidate.displayName, ...publicAttributeValues].join("\n")),
      );
      const overlapLabels = queryTokens.filter((token) =>
        haystackTokens.has(token),
      );
      const hasExplainableMatch =
        overlapLabels.length > 0 || evaluation.reasons.length > 0;
      if (hasRequestCriteria && !hasExplainableMatch) return [];
      const lexicalScore =
        overlapLabels.length / Math.max(4, queryTokens.length);
      const score = hasRequestCriteria
        ? Math.min(0.99, lexicalScore + evaluation.boost)
        : undefined;
      return [
        {
          ...candidate,
          score,
          overlapLabels,
          intentReasons: evaluation.reasons,
          index,
        },
      ];
    })
    .sort(
      (left, right) =>
        right.overlapLabels.length - left.overlapLabels.length ||
        (right.score ?? 0) - (left.score ?? 0) ||
        left.index - right.index,
    );
}

/** Deduplicate and bound explanations without cutting a UTF-16 surrogate pair. */
export function boundedMatchReasons(values: string[]): string[] {
  const reasons: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    let reason = normalized.slice(0, MAX_PUBLIC_MATCH_REASON_CHARACTERS);
    const trailingCodeUnit = reason.charCodeAt(reason.length - 1);
    if (trailingCodeUnit >= 0xd800 && trailingCodeUnit <= 0xdbff) {
      reason = reason.slice(0, -1);
    }
    if (!reason || seen.has(reason)) continue;
    seen.add(reason);
    reasons.push(reason);
    if (reasons.length === MAX_PUBLIC_MATCH_REASONS) break;
  }
  return reasons;
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

function hasStructuredIntentCriteria(
  intent: PublicShoppingIntent | undefined,
): boolean {
  return Boolean(intent?.budget) || Boolean(intent?.requirements.length);
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

function tokenize(value: string): string[] {
  const normalized = value.toLocaleLowerCase().slice(0, 8_000);
  const words = normalized.match(/[a-z0-9][a-z0-9._:-]*/g) ?? [];
  const cjk = [...normalized.matchAll(/[\u3400-\u9fff]/g)].map(
    ([character]) => character,
  );
  return [...new Set([...words, ...cjk])].slice(0, 512);
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

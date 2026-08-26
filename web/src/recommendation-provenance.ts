import type {
  MarketplaceOfferCandidate,
  RecommendedBackendListing,
} from "./api";
import type { RetrievalCandidate } from "./retrieval-protocol";
import { boundedMatchReasons } from "./storefront-ranking-shared";

interface RecommendationContext {
  tenantId?: string;
  domainId: string;
  platformPath: string;
  subplatform: string;
  intentId: string;
  fieldLabels: (attributes: Record<string, unknown>) => Record<string, string>;
}

/** Build public recommendations exclusively from kernel-owned match evidence. */
export function buildCanonicalRecommendations(
  candidates: MarketplaceOfferCandidate[],
  context: RecommendationContext,
): RecommendedBackendListing[] {
  return candidates.map((candidate) =>
    buildCanonicalRecommendation(candidate, context),
  );
}

/**
 * Intersect advisory provider retrieval with canonical matches.
 *
 * Provider scores and risks are intentionally ignored. Provider explanations are retained only
 * as bounded retrieval hints and can never overwrite verified matcher evidence.
 */
export function buildProviderSelectedRecommendations(
  canonicalCandidates: MarketplaceOfferCandidate[],
  providerCandidates: RetrievalCandidate[],
  context: RecommendationContext,
): RecommendedBackendListing[] {
  const providerByOffer = new Map<string, RetrievalCandidate>();
  for (const candidate of providerCandidates) {
    if (candidate.offerId && !providerByOffer.has(candidate.offerId)) {
      providerByOffer.set(candidate.offerId, candidate);
    }
  }

  return canonicalCandidates.flatMap((candidate) => {
    const providerCandidate = providerByOffer.get(candidate.offer_id);
    return providerCandidate
      ? [
          buildCanonicalRecommendation(
            candidate,
            context,
            providerCandidate.reasons,
          ),
        ]
      : [];
  });
}

function buildCanonicalRecommendation(
  candidate: MarketplaceOfferCandidate,
  context: RecommendationContext,
  providerReasons?: string[],
): RecommendedBackendListing {
  const { score, reasons, risks, ...offer } = candidate;
  const canonicalReasons = boundedMatchReasons(reasons);
  const canonicalRisks = boundedMatchReasons(risks ?? []);
  const providerHints = boundedMatchReasons(providerReasons ?? []);

  return {
    ...offer,
    field_labels: context.fieldLabels(candidate.attributes),
    tenant_id: context.tenantId ?? candidate.tenant_id,
    domain_id: context.domainId,
    platform_path: context.platformPath,
    subplatform: context.subplatform,
    ...(Number.isFinite(score) ? { match_score: score } : {}),
    match_reasons: canonicalReasons,
    ...(canonicalRisks.length ? { match_risks: canonicalRisks } : {}),
    ...(providerHints.length ? { provider_hints: providerHints } : {}),
    intent_id: context.intentId,
  };
}

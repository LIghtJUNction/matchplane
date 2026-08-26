import type { PublicStore } from "./store-directory";
import {
  type GatewayLexicalRankedCandidate,
  LEXICAL_RANK_ADVISORY,
  type PreparedLexicalRankCandidate,
} from "./storefront-ranking-contract";

export const store: PublicStore = {
  id: "10000000-0000-4000-8000-000000000001",
  slug: "camera-house",
  path: "/camera-house",
  displayName: "相机屋",
  description: "相机与镜头",
  integrationKind: "hosted",
  capabilities: [],
  agentStages: [],
  agentSkills: [],
  tenantId: "20000000-0000-4000-8000-000000000001",
  domainId: "30000000-0000-4000-8000-000000000001",
};

export function completeProductRow(
  input: {
    id?: string;
    displayName?: string;
    description?: string;
    amountMinor?: string;
    attributes?: Record<string, unknown>;
  } = {},
) {
  const id = input.id ?? "40000000-0000-4000-8000-000000000099";
  return {
    id,
    tenantId: store.tenantId,
    domainId: store.domainId,
    displayName: input.displayName ?? "轻便旅行相机",
    attributes: {
      description: input.description ?? "适合旅行拍摄",
      stock_quantity: 2,
      ...input.attributes,
      attachments: [
        {
          kind: "image",
          attachment_ref: `media://hosted/${id}`,
          file_name: `${id}.webp`,
          media_type: "image/webp",
        },
      ],
    },
    terms: {
      pricing_mode: "fixed",
      amount_minor: input.amountMinor ?? "129900",
      currency: "CNY",
      currency_scale: 2,
    },
    storeName: store.displayName,
    storeSlug: store.slug,
    storePath: store.path,
    integrationKind: store.integrationKind,
    supplyFields: [],
    publishedAt: "2026-08-21T00:00:00Z",
    likeTotal: "0",
  };
}

function fakeRustTokens(value: string): string[] {
  const normalized = value.toLocaleLowerCase();
  const words = normalized.match(/[a-z0-9][a-z0-9._:-]*/g) ?? [];
  const cjk = [...normalized.matchAll(/[\u3400-\u9fff]/g)].map(
    ([character]) => character,
  );
  return [...new Set([...words, ...cjk])].slice(0, 512);
}

export async function fakeRustRank(
  narrative: string,
  candidates: PreparedLexicalRankCandidate[],
): Promise<GatewayLexicalRankedCandidate[]> {
  const queryTokens = fakeRustTokens(narrative);
  return candidates.flatMap((candidate, candidateIndex) => {
    if (!candidate.eligible) return [];
    const haystack = new Set(
      fakeRustTokens(`${candidate.displayName}\n${candidate.description}`),
    );
    const overlapLabels = queryTokens.filter((token) => haystack.has(token));
    if (!overlapLabels.length && !candidate.intentReasons.length) return [];
    return [
      {
        candidateIndex,
        score: Math.min(
          0.99,
          overlapLabels.length / Math.max(4, queryTokens.length) +
            candidate.intentBoost,
        ),
        overlapCount: overlapLabels.length,
        overlapLabels,
        advisory: LEXICAL_RANK_ADVISORY,
      },
    ];
  });
}

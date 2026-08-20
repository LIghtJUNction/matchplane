import { randomUUID } from "node:crypto";

import { auth, authDatabase } from "./lib/auth";
import { executeAuthenticatedChildTool } from "./platform-child-tool";
import { CATALOG_PROTOCOL, type CatalogSyncRequest } from "./catalog-protocol";

export interface CatalogSyncOutcome {
  ok: boolean;
  status: number;
  synced: boolean;
  offerId: string;
  platformPath: string | null;
  payload: Record<string, unknown>;
}

/**
 * Re-read one offer from the root database, verify the Better Auth owner, and send only the
 * canonical opaque projection to the active child. The browser never gets to choose attributes,
 * terms, supply party or publication status for the child index.
 */
export async function syncCanonicalMarketplaceOffer(input: {
  request: Request;
  offerId: string;
  tenantId: string;
  requested?: Partial<Pick<CatalogSyncRequest, "domainId" | "platformPath">>;
}): Promise<CatalogSyncOutcome> {
  const session = await auth.api.getSession({ headers: input.request.headers });
  if (!session) return failure(401, input.offerId, "Better Auth session is required");

  const result = await authDatabase.query<CanonicalOfferRow>(
    `WITH RECURSIVE platform_tree AS (
       SELECT o.id, o."parentOrganizationId", o.slug, o."domainId", '/'::text AS platform_path
         FROM "organization" o
        WHERE o."tenantId" = $1::text AND o."parentOrganizationId" IS NULL AND o."rootPlatform" = true
       UNION ALL
       SELECT child.id, child."parentOrganizationId", child.slug, child."domainId",
              CASE WHEN platform_tree.platform_path = '/' THEN '/' || child.slug
                   ELSE platform_tree.platform_path || '/' || child.slug END
         FROM "organization" child
         JOIN platform_tree ON child."parentOrganizationId" = platform_tree.id
                           AND child."tenantId" = $1::text
        WHERE length(platform_tree.platform_path) < 4096
     )
     SELECT offer.id::text AS offer_id,
            offer.tenant_id::text AS tenant_id,
            offer.domain_id::text AS domain_id,
            offer.supply_party_id::text AS supply_party_id,
            offer.external_key,
            offer.display_name,
            offer.attributes,
            offer.terms,
            offer.status,
            tree.platform_path,
            EXISTS (
              SELECT 1 FROM marketplace_party_auth_links link
               WHERE link.tenant_id = offer.tenant_id
                 AND link.party_id = offer.supply_party_id
                 AND link.auth_user_id = $2::uuid
            ) AS owner
       FROM marketplace_offers offer
       LEFT JOIN platform_tree tree
         ON NULLIF(tree."domainId", '')::uuid = offer.domain_id
      WHERE offer.tenant_id = $1::uuid AND offer.id = $3::uuid
      LIMIT 1`,
    [input.tenantId, session.user.id, input.offerId],
  );
  const offer = result.rows[0];
  if (!offer) return failure(404, input.offerId, "供给不存在或不属于当前根 tenant");
  const role = (session.user as { role?: unknown }).role;
  const rootAdmin = role === "rootSuperAdmin" || role === "rootAdmin";
  if (!rootAdmin && !offer.owner) return failure(403, input.offerId, "当前账号不能同步该供给");
  if (offer.status !== "active") {
    return failure(409, input.offerId, "供给必须先通过根平台审核并处于 active 状态后才能同步目录");
  }
  if (input.requested?.domainId && input.requested.domainId !== offer.domain_id) {
    return failure(403, input.offerId, "供给 domain 与当前平台不一致");
  }
  if (!offer.platform_path || !/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(offer.platform_path)) {
    return failure(409, input.offerId, "供给尚未绑定可路由的子平台路径");
  }
  if (input.requested?.platformPath && input.requested.platformPath !== offer.platform_path) {
    return failure(403, input.offerId, "供给平台路径与当前平台不一致");
  }

  const execution = await executeAuthenticatedChildTool({
    request: input.request,
    platformPath: offer.platform_path,
    toolName: "catalog.upsert",
    arguments: {
      protocol: CATALOG_PROTOCOL,
      request_id: randomUUID(),
      scope: {
        tenant_id: offer.tenant_id,
        domain_id: offer.domain_id,
        platform_path: offer.platform_path,
      },
      offer: {
        offer_id: offer.offer_id,
        external_key: offer.external_key,
        display_name: offer.display_name,
        attributes: asObject(offer.attributes),
        terms: asObject(offer.terms),
        status: offer.status,
      },
    },
    permissions: { marketplace: ["write"] },
    tenantId: offer.tenant_id,
    domainId: offer.domain_id,
    allowSession: true,
  });
  if (!execution.ok) {
    return {
      ok: false,
      status: execution.status,
      synced: false,
      offerId: offer.offer_id,
      platformPath: offer.platform_path,
      payload: execution.payload,
    };
  }
  return {
    ok: true,
    status: execution.status,
    synced: true,
    offerId: offer.offer_id,
    platformPath: offer.platform_path,
    payload: execution.payload,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function failure(status: number, offerId: string, error: string): CatalogSyncOutcome {
  return { ok: false, status, synced: false, offerId, platformPath: null, payload: { error } };
}

interface CanonicalOfferRow {
  offer_id: string;
  tenant_id: string;
  domain_id: string;
  supply_party_id: string;
  external_key: string;
  display_name: string;
  attributes: unknown;
  terms: unknown;
  status: string;
  platform_path: string | null;
  owner: boolean;
}

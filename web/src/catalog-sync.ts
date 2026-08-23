import { randomUUID } from "node:crypto";

import { auth, authDatabase } from "./lib/auth";
import { executeAuthenticatedChildTool } from "./platform-child-tool";
import type { CatalogSyncRequest } from "./catalog-protocol";
import {
  buildCatalogProjectionArguments,
  parseCatalogProjectionAck,
  type CatalogOfferStatus,
} from "./catalog-projection";

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
  if (!session)
    return failure(401, input.offerId, "Better Auth session is required");

  const result = await authDatabase.query<CanonicalOfferRow>(
    `WITH RECURSIVE legacy_platform_tree AS (
       SELECT o.id, o."parentOrganizationId", o.slug, o."domainId", '/'::text AS platform_path
         FROM "organization" o
        WHERE o."tenantId" = $1::text AND o."parentOrganizationId" IS NULL AND o."rootPlatform" = true
       UNION ALL
       SELECT child.id, child."parentOrganizationId", child.slug, child."domainId",
              CASE WHEN legacy_platform_tree.platform_path = '/' THEN '/' || child.slug
                   ELSE legacy_platform_tree.platform_path || '/' || child.slug END
         FROM "organization" child
         JOIN legacy_platform_tree ON child."parentOrganizationId" = legacy_platform_tree.id
                           AND child."tenantId" = $1::text
        WHERE length(legacy_platform_tree.platform_path) < 4096
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
            offer.version::text AS canonical_version,
            COALESCE(alias.path, tree.platform_path) AS platform_path,
            store.integration_kind,
            EXISTS (
              SELECT 1 FROM marketplace_party_auth_links link
               WHERE link.tenant_id = offer.tenant_id
                 AND link.party_id = offer.supply_party_id
                 AND link.auth_user_id = $2::uuid
            ) AS owner
       FROM marketplace_offers offer
       LEFT JOIN stores store
         ON store.tenant_id = offer.tenant_id
        AND store.id = offer.store_id
       LEFT JOIN store_path_aliases alias
         ON alias.tenant_id = store.tenant_id
        AND alias.store_id = store.id
        AND alias.is_canonical = true
       LEFT JOIN legacy_platform_tree tree
         ON NULLIF(tree."domainId", '')::uuid = offer.domain_id
      WHERE offer.tenant_id = $1::uuid AND offer.id = $3::uuid
      LIMIT 1`,
    [input.tenantId, session.user.id, input.offerId],
  );
  const offer = result.rows[0];
  if (!offer)
    return failure(404, input.offerId, "供给不存在或不属于当前根 tenant");
  const role = (session.user as { role?: unknown }).role;
  const rootAdmin = role === "rootSuperAdmin" || role === "rootAdmin";
  if (!rootAdmin && !offer.owner)
    return failure(403, input.offerId, "当前账号不能同步该供给");
  if (offer.status !== "active") {
    return failure(
      409,
      input.offerId,
      "供给必须先通过根平台审核并处于 active 状态后才能同步目录",
    );
  }
  if (
    input.requested?.domainId &&
    input.requested.domainId !== offer.domain_id
  ) {
    return failure(403, input.offerId, "供给 domain 与当前平台不一致");
  }
  if (
    !offer.platform_path ||
    !/^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(offer.platform_path)
  ) {
    return failure(409, input.offerId, "供给尚未绑定可路由的子平台路径");
  }
  if (
    input.requested?.platformPath &&
    input.requested.platformPath !== offer.platform_path
  ) {
    return failure(403, input.offerId, "供给平台路径与当前平台不一致");
  }

  // A hosted store writes directly into the mall's canonical catalog. There is no child index
  // to synchronize, so activation itself completes publication.
  if (offer.integration_kind === "hosted") {
    return {
      ok: true,
      status: 200,
      synced: true,
      offerId: offer.offer_id,
      platformPath: offer.platform_path,
      payload: { catalog: "mall", mode: "canonical" },
    };
  }

  let projection;
  try {
    projection = buildCatalogProjectionArguments({
      requestId: randomUUID(),
      tenantId: offer.tenant_id,
      domainId: offer.domain_id,
      platformPath: offer.platform_path,
      offer: {
        offerId: offer.offer_id,
        externalKey: offer.external_key,
        displayName: offer.display_name,
        attributes: asObject(offer.attributes),
        terms: asObject(offer.terms),
        status: offer.status,
        canonicalVersion: Number(offer.canonical_version),
      },
    });
  } catch {
    return failure(500, input.offerId, "规范供给版本无法安全投影");
  }
  const execution = await executeAuthenticatedChildTool({
    request: input.request,
    platformPath: offer.platform_path,
    toolName: "catalog.upsert",
    arguments: projection,
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
  const acknowledgement = parseCatalogProjectionAck(
    execution.payload,
    projection,
  );
  if (!acknowledgement.ok) {
    return {
      ok: false,
      status: 502,
      synced: false,
      offerId: offer.offer_id,
      platformPath: offer.platform_path,
      payload: { error: acknowledgement.error },
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
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function failure(
  status: number,
  offerId: string,
  error: string,
): CatalogSyncOutcome {
  return {
    ok: false,
    status,
    synced: false,
    offerId,
    platformPath: null,
    payload: { error },
  };
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
  status: CatalogOfferStatus;
  canonical_version: string;
  platform_path: string | null;
  integration_kind: string | null;
  owner: boolean;
}

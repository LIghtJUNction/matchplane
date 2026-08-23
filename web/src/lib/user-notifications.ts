import type { Pool, PoolClient } from "pg";

import { authDatabase } from "./auth";

type Queryable = Pool | PoolClient;

export interface PartyNotificationInput {
  tenantId: string;
  partyId: string;
  kind: string;
  sourceType: string;
  sourceId: string;
  title: string;
  body?: string | null;
  platformPath: string;
  actionPath: string;
  payload?: Record<string, unknown>;
  excludeAuthUserId?: string;
  client?: Queryable;
}

/**
 * Persist one bounded inbox item for every Better Auth account linked to a marketplace party.
 * Repeated source events update one row and make it unread again instead of creating notification
 * spam. Contact details and other secrets must never be passed in payload.
 */
export async function notifyPartyUsers(
  input: PartyNotificationInput,
): Promise<number> {
  if (
    !isInternalPath(input.platformPath) ||
    !isInternalPath(input.actionPath)
  ) {
    throw new Error("notification paths must be internal");
  }
  const client = input.client ?? authDatabase;
  const result = await client.query(
    `INSERT INTO user_notifications
       (id, recipient_auth_user_id, tenant_id, platform_path, kind, source_type,
        source_id, title, body, payload, action_path)
     SELECT gen_random_uuid(), link.auth_user_id, $1::uuid, $3, $4, $5,
            $6, $7, $8, $9::jsonb, $10
       FROM marketplace_party_auth_links link
      WHERE link.tenant_id = $1::uuid
        AND link.party_id = $2::uuid
        AND ($11::uuid IS NULL OR link.auth_user_id <> $11::uuid)
     ON CONFLICT (recipient_auth_user_id, source_type, source_id, kind)
     DO UPDATE SET title = EXCLUDED.title,
                   body = EXCLUDED.body,
                   payload = EXCLUDED.payload,
                   platform_path = EXCLUDED.platform_path,
                   action_path = EXCLUDED.action_path,
                   read_at = NULL,
                   archived_at = NULL,
                   created_at = clock_timestamp(),
                   updated_at = clock_timestamp()`,
    [
      input.tenantId,
      input.partyId,
      input.platformPath,
      bounded(input.kind, 80),
      bounded(input.sourceType, 80),
      bounded(input.sourceId, 256),
      bounded(input.title, 200),
      input.body ? bounded(input.body, 500) : null,
      JSON.stringify(input.payload ?? {}),
      input.actionPath,
      input.excludeAuthUserId ?? null,
    ],
  );
  return result.rowCount ?? 0;
}

function bounded(value: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(
      `notification text must be between 1 and ${maximum} characters`,
    );
  }
  return normalized;
}

function isInternalPath(value: string): boolean {
  return (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    value.length <= 1024 &&
    !/[\r\n]/.test(value)
  );
}

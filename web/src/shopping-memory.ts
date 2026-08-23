import { randomUUID } from "node:crypto";
import { authDatabase } from "./lib/auth";
import {
  SHOPPING_MEMORY_FACT_KINDS,
  type ShoppingMemoryFact,
  type ShoppingMemoryMutation,
  type ShoppingMemorySnapshot,
} from "./shopping-memory-contract";

const MAX_FACTS = 16;
const MAX_VALUE_LENGTH = 300;
const FACT_KIND_SET = new Set<string>(SHOPPING_MEMORY_FACT_KINDS);

interface ShoppingMemoryRow {
  enabled: boolean;
  facts: unknown;
  version: string | number;
  updated_at: Date | string;
}

export class ShoppingMemoryValidationError extends Error {}

export function parseShoppingMemoryMutation(
  value: unknown,
): ShoppingMemoryMutation {
  if (!isRecord(value)) throw new ShoppingMemoryValidationError("请求内容无效");
  if (typeof value.enabled !== "boolean")
    throw new ShoppingMemoryValidationError("请选择是否允许导购使用记忆");
  if (
    !Number.isSafeInteger(value.expectedVersion) ||
    Number(value.expectedVersion) < 0
  )
    throw new ShoppingMemoryValidationError("记忆版本无效，请刷新后重试");
  if (!Array.isArray(value.facts) || value.facts.length > MAX_FACTS)
    throw new ShoppingMemoryValidationError(`最多保存 ${MAX_FACTS} 条购物记忆`);

  const facts = value.facts.map(parseFact);
  const keys = new Set<string>();
  for (const fact of facts) {
    const identity = `${fact.kind}:${fact.key}`;
    if (keys.has(identity))
      throw new ShoppingMemoryValidationError("同一种记忆不能使用重复名称");
    keys.add(identity);
  }
  return {
    enabled: value.enabled,
    facts,
    expectedVersion: Number(value.expectedVersion),
  };
}

export async function readShoppingMemory(
  tenantId: string,
  authUserId: string,
): Promise<ShoppingMemorySnapshot> {
  const result = await authDatabase.query<ShoppingMemoryRow>(
    `SELECT enabled, facts, version, updated_at
       FROM shopping_memory_profiles
      WHERE tenant_id = $1::uuid AND auth_user_id = $2::uuid`,
    [tenantId, authUserId],
  );
  return result.rows[0] ? snapshotFromRow(result.rows[0]) : emptyMemory();
}

export async function writeShoppingMemory(input: {
  tenantId: string;
  authUserId: string;
  mutation: ShoppingMemoryMutation;
  source?: "self_service" | "assistant_revision" | "conversation_summary";
}): Promise<ShoppingMemorySnapshot | null> {
  const client = await authDatabase.connect();
  try {
    await client.query("BEGIN");
    const parameters = [
      input.tenantId,
      input.authUserId,
      input.mutation.enabled,
      JSON.stringify(input.mutation.facts),
    ];
    const result =
      input.mutation.expectedVersion === 0
        ? await client.query<ShoppingMemoryRow>(
            `INSERT INTO shopping_memory_profiles
               (tenant_id, auth_user_id, enabled, facts, version)
             VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, 1)
             ON CONFLICT (tenant_id, auth_user_id) DO NOTHING
             RETURNING enabled, facts, version, updated_at`,
            parameters,
          )
        : await client.query<ShoppingMemoryRow>(
            `UPDATE shopping_memory_profiles
                SET enabled = $3,
                    facts = $4::jsonb,
                    version = version + 1,
                    updated_at = clock_timestamp()
              WHERE tenant_id = $1::uuid
                AND auth_user_id = $2::uuid
                AND version = $5::bigint
              RETURNING enabled, facts, version, updated_at`,
            [...parameters, input.mutation.expectedVersion],
          );
    const row = result.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `INSERT INTO platform_audit_events
         (id, tenant_id, platform_path, actor_auth_user_id, event_type, outcome, metadata)
       VALUES ($1::uuid, $2::uuid, '/', $3::uuid,
               'shopping.memory.updated', 'success', $4::jsonb)`,
      [
        randomUUID(),
        input.tenantId,
        input.authUserId,
        JSON.stringify({
          enabled: input.mutation.enabled,
          fact_count: input.mutation.facts.length,
          fact_kinds: [
            ...new Set(input.mutation.facts.map((fact) => fact.kind)),
          ],
          version: Number(row.version),
          source: input.source ?? "self_service",
        }),
      ],
    );
    await client.query("COMMIT");
    return snapshotFromRow(row);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteShoppingMemory(input: {
  tenantId: string;
  authUserId: string;
}): Promise<ShoppingMemorySnapshot> {
  const client = await authDatabase.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<ShoppingMemoryRow>(
      `DELETE FROM shopping_memory_profiles
        WHERE tenant_id = $1::uuid AND auth_user_id = $2::uuid
        RETURNING enabled, facts, version, updated_at`,
      [input.tenantId, input.authUserId],
    );
    const previous = result.rows[0];
    if (previous) {
      const facts = normalizeStoredFacts(previous.facts);
      await client.query(
        `INSERT INTO platform_audit_events
           (id, tenant_id, platform_path, actor_auth_user_id, event_type, outcome, metadata)
         VALUES ($1::uuid, $2::uuid, '/', $3::uuid,
                 'shopping.memory.deleted', 'success', $4::jsonb)`,
        [
          randomUUID(),
          input.tenantId,
          input.authUserId,
          JSON.stringify({
            previous_enabled: previous.enabled,
            previous_fact_count: facts.length,
            previous_version: Number(previous.version),
          }),
        ],
      );
    }
    await client.query("COMMIT");
    return emptyMemory();
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function parseFact(value: unknown): ShoppingMemoryFact {
  if (!isRecord(value) || !FACT_KIND_SET.has(String(value.kind)))
    throw new ShoppingMemoryValidationError("记忆类型无效");
  const kind = String(value.kind) as ShoppingMemoryFact["kind"];
  const key = typeof value.key === "string" ? value.key.trim() : "";
  const factValue = typeof value.value === "string" ? value.value.trim() : "";
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key))
    throw new ShoppingMemoryValidationError("记忆名称无效");
  if (
    !factValue ||
    factValue.length > MAX_VALUE_LENGTH ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(factValue)
  )
    throw new ShoppingMemoryValidationError(
      `每条记忆需要 1 到 ${MAX_VALUE_LENGTH} 个字符`,
    );

  if (kind === "budget") {
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(factValue))
      throw new ShoppingMemoryValidationError("预算必须是有效金额");
    const amount = Number(factValue);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000_000_000)
      throw new ShoppingMemoryValidationError("预算金额超出可保存范围");
    const currency =
      typeof value.currency === "string"
        ? value.currency.trim().toUpperCase()
        : "CNY";
    if (!/^[A-Z]{3}$/.test(currency))
      throw new ShoppingMemoryValidationError("预算币种无效");
    return { kind, key, value: factValue, currency };
  }
  return { kind, key, value: factValue };
}

function normalizeStoredFacts(value: unknown): ShoppingMemoryFact[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_FACTS).flatMap((fact) => {
    try {
      return [parseFact(fact)];
    } catch {
      return [];
    }
  });
}

function snapshotFromRow(row: ShoppingMemoryRow): ShoppingMemorySnapshot {
  const updatedAt =
    row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : new Date(row.updated_at).toISOString();
  return {
    enabled: row.enabled,
    facts: normalizeStoredFacts(row.facts),
    version: Number(row.version),
    updatedAt,
  };
}

function emptyMemory(): ShoppingMemorySnapshot {
  return { enabled: true, facts: [], version: 0, updatedAt: null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

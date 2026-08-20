import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { Pool } from "pg";

const database = new Pool({
  connectionString: process.env.MATCHPLANE_DATABASE_URL ?? process.env.DATABASE_URL,
  max: Number(process.env.MATCHPLANE_ROOT_EMAIL_CONFIG_POOL_SIZE ?? 3),
});

const slotPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const providerKeyPattern = /^[a-z0-9][a-z0-9._-]{1,99}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROOT_EMAIL_SECRET_ROOT = "/etc/matchplane/secrets/root-email";

export type RootEmailTlsMode = "starttls" | "tls" | "plain";
export type RootEmailMode = "test" | "production";

export interface RootEmailConfig {
  providerKey: string;
  smtpHost: string;
  smtpPort: number;
  tlsMode: RootEmailTlsMode;
  username: string;
  credentialSlot: string;
  credentialConfigured: boolean;
  fromAddress: string;
  replyTo: string | null;
  mode: RootEmailMode;
  enabled: boolean;
  version: number;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface RootEmailConfigInput {
  providerKey: string;
  smtpHost: string;
  smtpPort: number;
  tlsMode: RootEmailTlsMode;
  username: string;
  credentialSlot: string;
  fromAddress: string;
  replyTo?: string | null;
  mode: RootEmailMode;
  enabled: boolean;
  expectedVersion?: number;
  actorUserId: string;
}

interface RootEmailConfigRow {
  provider_key: string;
  smtp_host: string;
  smtp_port: number;
  tls_mode: RootEmailTlsMode;
  username: string;
  credential_slot: string;
  from_address: string;
  reply_to: string | null;
  mode: RootEmailMode;
  enabled: boolean;
  version: string | number;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
}

/** A browser-safe root SMTP record. The actual password stays in a root-owned secret slot. */
export async function getRootEmailConfig(): Promise<RootEmailConfig | null> {
  const result = await database.query<RootEmailConfigRow>(
    `SELECT provider_key, smtp_host, smtp_port, tls_mode, username, credential_slot,
            from_address, reply_to, mode, enabled, version, updated_by, created_at, updated_at
       FROM root_email_config
      WHERE singleton = true`,
  );
  const row = result.rows[0];
  if (!row) return null;
  const config = toPublicConfig(row);
  return { ...config, credentialConfigured: await isRootEmailCredentialConfigured(config.credentialSlot) };
}

/** Returns a validated active record to the server mailer. */
export async function getActiveRootEmailConfig(): Promise<RootEmailConfig | null> {
  const config = await getRootEmailConfig();
  return config?.enabled && config.credentialConfigured ? config : null;
}

/**
 * Stores metadata only. The credential slot must be provisioned by `matchplane secret put`,
 * keeping passwords and OAuth/SMTP secrets out of browser payloads and PostgreSQL.
 */
export async function saveRootEmailConfig(input: RootEmailConfigInput): Promise<RootEmailConfig> {
  validateInput(input);
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<Pick<RootEmailConfigRow, "version">>(
      "SELECT version FROM root_email_config WHERE singleton = true FOR UPDATE",
    );
    const currentVersion = current.rows[0] ? Number(current.rows[0].version) : undefined;
    if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
      throw new RootEmailConfigConflictError();
    }

    const result = currentVersion === undefined
      ? await client.query<RootEmailConfigRow>(
          `INSERT INTO root_email_config
             (singleton, provider_key, smtp_host, smtp_port, tls_mode, username, credential_slot,
              from_address, reply_to, mode, enabled, updated_by)
           VALUES (true, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::uuid)
           RETURNING provider_key, smtp_host, smtp_port, tls_mode, username, credential_slot,
                     from_address, reply_to, mode, enabled, version, updated_by, created_at, updated_at`,
          values(input),
        )
      : await client.query<RootEmailConfigRow>(
          `UPDATE root_email_config
              SET provider_key = $1, smtp_host = $2, smtp_port = $3, tls_mode = $4,
                  username = $5, credential_slot = $6, from_address = $7, reply_to = $8,
                  mode = $9, enabled = $10, updated_by = $11::uuid, version = version + 1
            WHERE singleton = true
            RETURNING provider_key, smtp_host, smtp_port, tls_mode, username, credential_slot,
                      from_address, reply_to, mode, enabled, version, updated_by, created_at, updated_at`,
          values(input),
        );
    const row = result.rows[0];
    if (!row) throw new Error("根邮箱配置没有保存");
    const saved = toPublicConfig(row);
    await client.query(
      `INSERT INTO root_email_config_audit (config_version, actor_user_id, action, details)
       VALUES ($1, $2::uuid, $3, $4::jsonb)`,
      [saved.version, input.actorUserId, currentVersion === undefined ? "created" : "updated", JSON.stringify(auditDetails(saved))],
    );
    await client.query("COMMIT");
    return { ...saved, credentialConfigured: await isRootEmailCredentialConfigured(saved.credentialSlot) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Audit a bounded, fixed-content test; callers must already verify the super-admin recipient. */
export async function recordRootEmailConfigTest(actorUserId: string): Promise<void> {
  const config = await getRootEmailConfig();
  if (!config) throw new Error("根邮箱尚未配置");
  await database.query(
    `INSERT INTO root_email_config_audit (config_version, actor_user_id, action, details)
     VALUES ($1, $2::uuid, 'tested', $3::jsonb)`,
    [config.version, actorUserId, JSON.stringify({ provider_key: config.providerKey, smtp_host: config.smtpHost })],
  );
}

/** Root secret slots are deployment-owned files; user input cannot select a path. */
export async function readRootEmailCredential(slot: string): Promise<string> {
  if (!slotPattern.test(slot)) throw new Error("根邮箱密钥槽无效");
  const root = ROOT_EMAIL_SECRET_ROOT;
  const candidate = path.join(root, slot);
  if (!isWithin(root, candidate)) throw new Error("根邮箱密钥槽路径无效");
  try {
    await access(candidate);
    // This is a host-mounted secret directory, deliberately outside Next's traced application
    // tree. `slot` has already passed the strict filename allowlist above.
    const value = (await readFile(/* turbopackIgnore: true */ candidate, "utf8")).trim();
    if (!value) throw new Error("根邮箱密钥槽为空");
    return value;
  } catch (error) {
    if (error instanceof Error && /根邮箱密钥槽/.test(error.message)) throw error;
    throw new Error("根邮箱密钥槽尚未配置");
  }
}

/** Check availability without disclosing the secret or its path. */
export async function isRootEmailCredentialConfigured(slot: string): Promise<boolean> {
  try {
    await readRootEmailCredential(slot);
    return true;
  } catch {
    return false;
  }
}

export class RootEmailConfigConflictError extends Error {
  constructor() {
    super("根邮箱配置已被其他管理员更新，请刷新后再保存");
  }
}

function values(input: RootEmailConfigInput): unknown[] {
  return [
    input.providerKey.trim(),
    input.smtpHost.trim().toLowerCase(),
    input.smtpPort,
    input.tlsMode,
    input.username.trim(),
    input.credentialSlot.trim(),
    input.fromAddress.trim().toLowerCase(),
    input.replyTo?.trim().toLowerCase() || null,
    input.mode,
    input.enabled,
    input.actorUserId,
  ];
}

function validateInput(input: RootEmailConfigInput): void {
  if (!providerKeyPattern.test(input.providerKey.trim())) throw new Error("Provider key 格式无效");
  if (!isSafeSmtpHost(input.smtpHost)) throw new Error("SMTP 主机无效或不允许使用本机地址");
  if (!Number.isInteger(input.smtpPort) || input.smtpPort < 1 || input.smtpPort > 65_535) throw new Error("SMTP 端口必须在 1 到 65535 之间");
  if (input.tlsMode !== "starttls" && input.tlsMode !== "tls" && input.tlsMode !== "plain") throw new Error("TLS 模式无效");
  if (!input.username.trim() || input.username.length > 320) throw new Error("SMTP 用户名无效");
  if (!slotPattern.test(input.credentialSlot.trim())) throw new Error("密钥槽只能包含字母、数字、点、下划线或连字符");
  if (!isEmail(input.fromAddress) || (input.replyTo && !isEmail(input.replyTo))) throw new Error("发件人或回复地址无效");
  if (input.mode !== "test" && input.mode !== "production") throw new Error("发送模式无效");
  if (!isUuid(input.actorUserId)) throw new Error("管理员身份无效");
}

function toPublicConfig(row: RootEmailConfigRow): RootEmailConfig {
  return {
    providerKey: row.provider_key,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    tlsMode: row.tls_mode,
    username: row.username,
    credentialSlot: row.credential_slot,
    credentialConfigured: false,
    fromAddress: row.from_address,
    replyTo: row.reply_to,
    mode: row.mode,
    enabled: row.enabled,
    version: Number(row.version),
    updatedBy: row.updated_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function auditDetails(config: RootEmailConfig): Record<string, unknown> {
  return {
    provider_key: config.providerKey,
    smtp_host: config.smtpHost,
    smtp_port: config.smtpPort,
    tls_mode: config.tlsMode,
    credential_slot: config.credentialSlot,
    mode: config.mode,
    enabled: config.enabled,
  };
}

function isSafeSmtpHost(value: string): boolean {
  const host = value.trim().toLowerCase();
  if (!host || host.length > 255 || host === "localhost" || host.endsWith(".localhost")) return false;
  if (/^(127(?:\.\d{1,3}){3}|0(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2})$/.test(host)) return false;
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host);
}

function isEmail(value: string): boolean {
  return value.trim().length <= 320 && emailPattern.test(value.trim());
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

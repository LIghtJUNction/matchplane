import { readFile } from "node:fs/promises";

import nodemailer from "nodemailer";

import { Pool } from "pg";

const database = new Pool({
  connectionString: process.env.MATCHPLANE_DATABASE_URL ?? process.env.DATABASE_URL,
  max: Number(process.env.MATCHPLANE_MAIL_POOL_SIZE ?? 4),
});

interface AuthEmailInput {
  request?: Request;
  recipient: string;
  subject: string;
  text: string;
  html: string;
}

interface EmailRoute {
  providerKey: string;
  smtpHost: string;
  smtpPort: number;
  tlsMode: string;
  username: string;
  credentialSecretRef: string;
  fromAddress: string;
  replyTo: string | null;
  mode: string;
  enabled: boolean;
}

/**
 * Root authentication is needed before a platform administrator can configure a child node.
 * Keep this bootstrap route deployment-owned: the password is still resolved from an env/file
 * reference and never stored in PostgreSQL, a manifest, or the browser. Child routes continue to
 * come from `subplatform_email_configs` and can be changed by their scoped administrators.
 */
export function rootEmailRouteFromEnv(environment = process.env.MATCHPLANE_ENVIRONMENT): EmailRoute | null {
  const fields = {
    host: process.env.MATCHPLANE_ROOT_SMTP_HOST?.trim() ?? "",
    port: process.env.MATCHPLANE_ROOT_SMTP_PORT?.trim() ?? "",
    tlsMode: process.env.MATCHPLANE_ROOT_SMTP_TLS_MODE?.trim() ?? "",
    username: process.env.MATCHPLANE_ROOT_SMTP_USERNAME?.trim() ?? "",
    credentialSecretRef: process.env.MATCHPLANE_ROOT_SMTP_CREDENTIAL_SECRET_REF?.trim() ?? "",
    fromAddress: process.env.MATCHPLANE_ROOT_SMTP_FROM_ADDRESS?.trim() ?? "",
    replyTo: process.env.MATCHPLANE_ROOT_SMTP_REPLY_TO?.trim() ?? "",
  };
  // A default `enabled=true` flag in a deployment template must not turn an empty optional
  // section into a broken route. Any actual connection field opts in and is then validated as a
  // complete tuple below.
  const configured = Object.values(fields).some(Boolean);
  if (!configured) return null;

  const smtpPort = Number.parseInt(fields.port, 10);
  if (!fields.host || !Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65_535) {
    throw new Error("根平台 SMTP 必须同时配置有效的 MATCHPLANE_ROOT_SMTP_HOST 和 MATCHPLANE_ROOT_SMTP_PORT");
  }
  if (!(["starttls", "tls", "plain"] as const).includes(fields.tlsMode as "starttls" | "tls" | "plain")) {
    throw new Error("MATCHPLANE_ROOT_SMTP_TLS_MODE 必须是 starttls、tls 或 plain");
  }
  if (!fields.username || !fields.credentialSecretRef || !isSecretReference(fields.credentialSecretRef)) {
    throw new Error("根平台 SMTP 必须配置 username 和 env:// 或 file:// credential secret reference");
  }
  if (!isEmailAddress(fields.fromAddress) || (fields.replyTo && !isEmailAddress(fields.replyTo))) {
    throw new Error("根平台 SMTP 的 from/reply-to 地址无效");
  }
  const enabled = parseBoolean(process.env.MATCHPLANE_ROOT_SMTP_ENABLED, true);
  const mode = process.env.MATCHPLANE_ROOT_SMTP_MODE?.trim()
    || (environment === "production" ? "production" : "test");
  if (mode !== "test" && mode !== "production") {
    throw new Error("MATCHPLANE_ROOT_SMTP_MODE 必须是 test 或 production");
  }
  return {
    providerKey: process.env.MATCHPLANE_ROOT_SMTP_PROVIDER_KEY?.trim() || "root-smtp",
    smtpHost: fields.host,
    smtpPort,
    tlsMode: fields.tlsMode,
    username: fields.username,
    credentialSecretRef: fields.credentialSecretRef,
    fromAddress: fields.fromAddress,
    replyTo: fields.replyTo || null,
    mode,
    enabled,
  };
}

/** Send Better Auth lifecycle messages through the selected subplatform's configured route. */
export async function sendConfiguredAuthEmail(input: AuthEmailInput): Promise<void> {
  const route = await loadEmailRoute(input.request);
  if (!route || !route.enabled) {
    throw new Error("当前子平台尚未启用邮箱发送路由");
  }

  const password = await resolveSecret(route.credentialSecretRef);
  const transport = nodemailer.createTransport({
    host: route.smtpHost,
    port: route.smtpPort,
    secure: route.tlsMode === "tls",
    requireTLS: route.tlsMode === "starttls",
    auth: { user: route.username, pass: password },
  });
  await transport.sendMail({
    from: route.fromAddress,
    to: input.recipient,
    replyTo: route.replyTo ?? undefined,
    subject: input.subject,
    text: input.text,
    html: input.html,
    headers: { "X-MatchPlane-Provider": route.providerKey },
  });
}

async function loadEmailRoute(request?: Request): Promise<EmailRoute | null> {
  const slug = request?.headers.get("x-matchplane-subplatform")?.trim() || "root";
  if (slug === "root") {
    const rootRoute = rootEmailRouteFromEnv();
    if (rootRoute) return rootRoute;
  }
  const result = await database.query<{
    provider_key: string;
    smtp_host: string;
    smtp_port: number;
    tls_mode: string;
    username: string;
    credential_secret_ref: string;
    from_address: string;
    reply_to: string | null;
    mode: string;
    enabled: boolean;
  }>(
    `SELECT c.provider_key, c.smtp_host, c.smtp_port, c.tls_mode, c.username,
            c.credential_secret_ref, c.from_address, c.reply_to, c.mode, c.enabled
       FROM subplatform_email_configs c
       JOIN domains d ON d.tenant_id = c.tenant_id AND d.id = c.domain_id
      WHERE d.status = 'active' AND c.enabled = true
        AND (
          d.slug = $1
          OR EXISTS (
            SELECT 1
              FROM subplatform_registrations r
             WHERE r.tenant_id = c.tenant_id
               AND r.domain_id = c.domain_id
               AND r.slug = $1
               AND r.state = 'active'
          )
        )
      ORDER BY c.updated_at DESC
      LIMIT 1`,
    [slug],
  );
  const row = result.rows[0];
  return row
    ? {
        providerKey: row.provider_key,
        smtpHost: row.smtp_host,
        smtpPort: row.smtp_port,
        tlsMode: row.tls_mode,
        username: row.username,
        credentialSecretRef: row.credential_secret_ref,
        fromAddress: row.from_address,
        replyTo: row.reply_to,
        mode: row.mode,
        enabled: row.enabled,
      }
    : null;
}

async function resolveSecret(reference: string): Promise<string> {
  if (reference.startsWith("env://")) {
    const variable = reference.slice("env://".length);
    const value = process.env[variable];
    if (!value) throw new Error(`邮箱 secret 环境变量 ${variable} 未配置`);
    return value;
  }
  if (reference.startsWith("file://")) {
    const value = (await readFile(reference.slice("file://".length), "utf8")).trim();
    if (!value) throw new Error("邮箱 secret 文件为空");
    return value;
  }
  throw new Error("邮箱 secret reference 必须使用 env:// 或 file://，不接受明文密码");
}

function isSecretReference(value: string): boolean {
  return (value.startsWith("env://") && value.length > "env://".length)
    || (value.startsWith("file://") && value.length > "file://".length);
}

function isEmailAddress(value: string): boolean {
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value.trim().toLowerCase() === "true") return true;
  if (value.trim().toLowerCase() === "false") return false;
  throw new Error("MATCHPLANE_ROOT_SMTP_ENABLED 必须是 true 或 false");
}

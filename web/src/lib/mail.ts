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

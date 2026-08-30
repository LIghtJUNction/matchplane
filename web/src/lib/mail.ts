import { readFile, realpath } from "node:fs/promises";
import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";

import nodemailer from "nodemailer";

import { Pool } from "pg";
import {
  getActiveRootEmailConfig,
  getRootEmailConfig,
  readRootEmailCredential,
} from "./root-email-config";
import { isUuid } from "./uuid";

const database = new Pool({
  connectionString: process.env.MATCHPLANE_DATABASE_URL ?? process.env.DATABASE_URL,
  max: Number(process.env.MATCHPLANE_MAIL_POOL_SIZE ?? 4),
});

interface AuthEmailInput {
  recipient: string;
  subject: string;
  text: string;
  html: string;
}

/** Server-side context for a child platform notification route. */
export interface PlatformEmailContext {
  tenantId: string;
  domainId: string;
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
  tenantId: string | null;
  domainId: string | null;
}

/**
 * Root authentication is shared by every mounted platform. Keep this bootstrap route deployment-
 * owned: the password is resolved from an env/file reference and never stored in PostgreSQL, a
 * manifest, or the browser. A child SMTP route must never be selected by an unauthenticated
 * request because that would let a child administrator redirect root auth mail.
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
    tenantId: null,
    domainId: null,
  };
}

/**
 * Prefer an administrator-managed active root route when one exists. Deployment variables remain
 * a break-glass/bootstrap fallback, so a new installation can still send the very first login
 * email before the control plane is available.
 */
export async function rootEmailRoute(): Promise<EmailRoute | null> {
  try {
    const managed = await managedRootEmailRoute();
    if (managed) return managed;
  } catch {
    // A migration or database outage must not disable the operator's known-good bootstrap route.
  }
  return rootEmailRouteFromEnv();
}

/**
 * Capability discovery for the login surface. Better Auth keeps the email methods enabled so
 * an operator can turn them on without changing code, but the UI must not advertise a method
 * when its deployment-owned SMTP route is absent or invalid.
 */
export async function isRootEmailAuthConfigured(): Promise<boolean> {
  try {
    const route = await rootEmailRoute();
    if (!route?.enabled) return false;
    // A syntactically valid secret reference is not enough for a useful button. Check only
    // presence/readability here; the sender still resolves the secret immediately before use.
    if (route.credentialSecretRef.startsWith("env://")) {
      return Boolean(process.env[route.credentialSecretRef.slice("env://".length)]?.trim());
    }
    if (route.credentialSecretRef.startsWith("file://")) {
      accessSync(route.credentialSecretRef.slice("file://".length), fsConstants.R_OK);
      return true;
    }
    if (route.credentialSecretRef.startsWith("secret://root-email/")) {
      await readRootEmailCredential(route.credentialSecretRef.slice("secret://root-email/".length));
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Send Better Auth lifecycle messages through the deployment-owned root route.
 *
 * Better Auth is the federated account authority for the whole platform tree. The request object
 * is intentionally not part of route selection: `x-matchplane-subplatform` is a UI/API routing
 * hint, not an authentication trust boundary.
 */
export async function sendConfiguredAuthEmail(input: AuthEmailInput): Promise<void> {
  const route = await rootEmailRoute();
  if (!route || !route.enabled) {
    throw new Error("根平台尚未启用邮箱发送路由");
  }

  await deliverEmail(route, input);
}

/** Fixed-content administrator verification for a newly saved root SMTP route. */
export async function sendRootEmailConfigTest(recipient: string): Promise<void> {
  const route = await managedRootEmailRoute({ requireEnabled: false });
  if (!route) throw new Error("请先保存 SMTP 配置和密码");
  await deliverEmail(route, {
    recipient,
    subject: "MatchPlane 根邮箱配置测试",
    text: "这是一封由根平台配置中心发出的测试邮件。若你收到此邮件，根认证邮件路由可以工作。",
    html: "<p>这是一封由根平台配置中心发出的测试邮件。</p><p>若你收到此邮件，根认证邮件路由可以工作。</p>",
  });
}

async function managedRootEmailRoute(options: { requireEnabled?: boolean } = {}): Promise<EmailRoute | null> {
  const managed = options.requireEnabled === false ? await getRootEmailConfig() : await getActiveRootEmailConfig();
  if (!managed || !managed.credentialConfigured || (options.requireEnabled !== false && !managed.enabled)) return null;
  return {
    providerKey: managed.providerKey,
    smtpHost: managed.smtpHost,
    smtpPort: managed.smtpPort,
    tlsMode: managed.tlsMode,
    username: managed.username,
    credentialSecretRef: "secret://root-email/smtp-password",
    fromAddress: managed.fromAddress,
    replyTo: managed.replyTo,
    mode: managed.mode,
    enabled: true,
    tenantId: null,
    domainId: null,
  };
}

/**
 * Send a platform-owned notification using an exact child tenant/domain route. The caller must
 * derive this context from an authenticated server-side platform record; never pass browser
 * headers or form values directly into this function.
 */
export async function sendConfiguredPlatformEmail(
  context: PlatformEmailContext,
  input: AuthEmailInput,
): Promise<void> {
  const route = await loadSubplatformEmailRoute(context);
  if (!route || !route.enabled) {
    throw new Error("当前子平台尚未启用邮箱发送路由");
  }

  await deliverEmail(route, input);
}

async function deliverEmail(route: EmailRoute, input: AuthEmailInput): Promise<void> {
  const password = await resolveSecret(route);
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

async function loadSubplatformEmailRoute(context: PlatformEmailContext): Promise<EmailRoute | null> {
  if (!isUuid(context.tenantId) || !isUuid(context.domainId)) return null;
  const result = await database.query<{
    tenant_id: string;
    domain_id: string;
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
    `SELECT c.tenant_id, c.domain_id, c.provider_key, c.smtp_host, c.smtp_port, c.tls_mode, c.username,
            c.credential_secret_ref, c.from_address, c.reply_to, c.mode, c.enabled
       FROM subplatform_email_configs c
       JOIN domains d ON d.tenant_id = c.tenant_id AND d.id = c.domain_id
      WHERE d.status = 'active' AND c.enabled = true
        AND c.tenant_id = $1::uuid
        AND c.domain_id = $2::uuid
      ORDER BY c.updated_at DESC
      LIMIT 1`,
    [context.tenantId, context.domainId],
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
        tenantId: row.tenant_id,
        domainId: row.domain_id,
      }
    : null;
}

async function resolveSecret(route: EmailRoute): Promise<string> {
  if (route.tenantId && route.domainId) {
    return resolveSubplatformSecret(route);
  }
  return resolveDeploymentSecret(route.credentialSecretRef);
}

async function resolveDeploymentSecret(reference: string): Promise<string> {
  if (reference.startsWith("secret://root-email/")) {
    return readRootEmailCredential(reference.slice("secret://root-email/".length));
  }
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
  throw new Error("根平台邮箱 secret reference 必须使用 env:// 或 file://，不接受明文密码");
}

async function resolveSubplatformSecret(route: EmailRoute): Promise<string> {
  const match = /^secret:\/\/subplatform\/([0-9a-f-]{36})\/([0-9a-f-]{36})\/([A-Za-z0-9._-]{1,128})$/i.exec(route.credentialSecretRef);
  if (!match || match[1].toLowerCase() !== route.tenantId?.toLowerCase() || match[2].toLowerCase() !== route.domainId?.toLowerCase()) {
    throw new Error("子平台邮箱 secret 必须是绑定当前 tenant/domain 的 secret:// 引用");
  }
  const secretRoot = process.env.MATCHPLANE_SUBPLATFORM_SECRET_ROOT?.trim();
  if (!secretRoot || !path.isAbsolute(secretRoot)) {
    throw new Error("子平台邮箱 secret 存储尚未配置");
  }
  const root = path.resolve(secretRoot);
  const candidate = path.resolve(
    /* turbopackIgnore: true */ root,
    match[1].toLowerCase(),
    match[2].toLowerCase(),
    match[3],
  );
  if (!isWithin(root, candidate)) throw new Error("子平台邮箱 secret 路径无效");
  try {
    const [rootReal, candidateReal] = await Promise.all([realpath(root), realpath(candidate)]);
    if (!isWithin(rootReal, candidateReal)) throw new Error("子平台邮箱 secret 路径越界");
    const value = (await readFile(candidateReal, "utf8")).trim();
    if (!value) throw new Error("子平台邮箱 secret 文件为空");
    return value;
  } catch (error) {
    if (error instanceof Error && /子平台邮箱 secret/.test(error.message)) throw error;
    throw new Error("子平台邮箱 secret 不可用");
  }
}

function isSecretReference(value: string): boolean {
  return (value.startsWith("env://") && value.length > "env://".length)
    || (value.startsWith("file://") && value.length > "file://".length);
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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

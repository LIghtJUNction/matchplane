import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { NextResponse } from "next/server";

import { auth, authDatabase } from "../../../../../src/lib/auth";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";

export const runtime = "nodejs";

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_MULTIPART_OVERHEAD = 1024 * 1024;

/**
 * Stores an opaque, unextracted subplatform archive for the isolated builder.
 *
 * The web process never extracts or executes the upload.  It only writes bounded bytes below
 * MATCHPLANE_SUBPLATFORM_UPLOAD_ROOT and returns an upload:// locator plus the digest that the
 * later registration request must repeat.  The builder is responsible for archive inspection,
 * manifest validation, extraction and build isolation.
 */
export async function POST(request: Request): Promise<Response> {
  if (!hasTrustedBrowserOrigin(request)) {
    return NextResponse.json({ error: "请求来源未被平台信任" }, { status: 403 });
  }
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ error: "Better Auth session is required" }, { status: 401 });

  const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isSafeInteger(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES + MAX_MULTIPART_OVERHEAD) {
    return NextResponse.json({ error: "子平台压缩包不能超过 64 MiB" }, { status: 413 });
  }

  const parentOrganizationId = readOptionalText(request.headers.get("x-matchplane-parent-organization-id"));
  if (parentOrganizationId && !isUuid(parentOrganizationId)) {
    return NextResponse.json({ error: "parentOrganizationId must be a UUID" }, { status: 400 });
  }
  const userRole = (session.user as { role?: string }).role;
  if (!(await canManageParent(session.user.id, userRole, parentOrganizationId))) {
    return NextResponse.json({ error: "当前账号没有上传该平台节点的权限" }, { status: 403 });
  }

  let form: FormData;
  try {
    // Request.formData() parses the complete multipart body before returning. Read the stream
    // through a hard cap first so chunked requests cannot bypass the archive limit and make the
    // Next/Node process buffer an unbounded body.
    const body = await readBodyBounded(request, MAX_ARCHIVE_BYTES + MAX_MULTIPART_OVERHEAD);
    form = await new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: Buffer.from(body),
    }).formData();
  } catch (error) {
    if (error instanceof BodyLimitError) {
      return NextResponse.json({ error: "子平台压缩包不能超过 64 MiB" }, { status: 413 });
    }
    return NextResponse.json({ error: "请使用 multipart/form-data 上传压缩包" }, { status: 400 });
  }
  const archive = form.get("archive");
  if (!(archive instanceof File)) {
    return NextResponse.json({ error: "缺少 archive 文件字段" }, { status: 400 });
  }
  if (!isSupportedArchiveName(archive.name)) {
    return NextResponse.json({ error: "仅支持 .tar.gz、.tgz、.tar.zst 或 .tzst 压缩包" }, { status: 400 });
  }
  if (archive.size <= 0 || archive.size > MAX_ARCHIVE_BYTES) {
    return NextResponse.json({ error: "子平台压缩包大小必须在 1 B 到 64 MiB 之间" }, { status: 413 });
  }

  const uploadRoot = process.env.MATCHPLANE_SUBPLATFORM_UPLOAD_ROOT?.trim();
  if (!uploadRoot || !path.isAbsolute(uploadRoot)) {
    return NextResponse.json({ error: "子平台上传存储尚未配置" }, { status: 503 });
  }
  const root = path.resolve(uploadRoot);
  const uploadId = randomUUID();
  const archivePath = path.resolve(root, `${uploadId}.archive`);
  if (!isWithin(root, archivePath)) {
    return NextResponse.json({ error: "上传存储路径无效" }, { status: 503 });
  }

  let wrotePath: string | null = null;
  try {
    await fs.mkdir(root, { recursive: true, mode: 0o750 });
    const fileHandle = await fs.open(archivePath, "wx", 0o600);
    const digest = createHash("sha256");
    let bytesWritten = 0;
    try {
      for await (const chunk of archive.stream()) {
        const bytes = Buffer.from(chunk);
        bytesWritten += bytes.length;
        if (bytesWritten > MAX_ARCHIVE_BYTES) throw new BodyLimitError();
        digest.update(bytes);
        await fileHandle.write(bytes);
      }
      await fileHandle.sync();
    } finally {
      await fileHandle.close();
    }
    wrotePath = archivePath;
    if (bytesWritten === 0) return NextResponse.json({ error: "子平台压缩包不能为空" }, { status: 413 });
    const sourceDigest = digest.digest("hex");
    return NextResponse.json({
      sourceKind: "archive",
      sourceLocator: `upload://${uploadId}`,
      sourceDigest,
      originalName: archive.name.slice(0, 255),
      size: bytesWritten,
      next: "submit_the_locator_and_digest_to_subplatform_registration",
    }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (wrotePath) await fs.unlink(wrotePath).catch(() => undefined);
    if (error instanceof BodyLimitError) {
      return NextResponse.json({ error: "子平台压缩包不能超过 64 MiB" }, { status: 413 });
    }
    console.error("subplatform archive upload failed", error);
    return NextResponse.json({ error: "子平台压缩包保存失败" }, { status: 500 });
  }
}

async function canManageParent(userId: string, role: string | null | undefined, parentId: string | null): Promise<boolean> {
  if (!parentId) return role === "rootSuperAdmin" || role === "rootAdmin";
  if (role === "rootSuperAdmin" || role === "rootAdmin") return true;
  const result = await authDatabase.query(
    `SELECT 1 FROM member
      WHERE "organizationId" = $1::uuid AND "userId" = $2::uuid
        AND role = ANY($3::text[])
      LIMIT 1`,
    [parentId, userId, ["owner", "admin", "subplatform_admin"]],
  );
  return result.rowCount === 1;
}

function readOptionalText(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

function isSupportedArchiveName(value: string): boolean {
  const name = path.basename(value).toLowerCase();
  return name.endsWith(".tar.gz") || name.endsWith(".tgz") || name.endsWith(".tar.zst") || name.endsWith(".tzst");
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

class BodyLimitError extends Error {
  constructor() {
    super("request body exceeds the configured limit");
    this.name = "BodyLimitError";
  }
}

async function readBodyBounded(request: Request, maximum: number): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maximum) throw new BodyLimitError();
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

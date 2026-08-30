import { randomUUID } from "node:crypto";
import { mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { isProductionEnvironment } from "./runtime";
import { isUuid } from "./uuid";

const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export type ManagedImageScope = "brand" | "profile";

export class ManagedImageError extends Error {}

/**
 * Store a small, user-owned branding/profile image outside the public repository. The generated
 * key is deliberately opaque: callers persist it in their own row and serving routes re-check
 * ownership before reading it back.
 */
export async function persistManagedImage(input: {
  scope: ManagedImageScope;
  ownerId: string;
  dataBase64: string;
}): Promise<{ key: string; bytes: number }> {
  if (!isUuid(input.ownerId)) throw new ManagedImageError("图片归属无效");
  const source = decodeBase64Image(input.dataBase64);
  const normalized = await normalizeImage(source);
  const root = await managedImageRoot();
  if (!root) throw new ManagedImageError("图片存储尚未配置");

  const imageId = randomUUID();
  const key = `${input.scope}/${input.ownerId}/${imageId}.webp`;
  const directory = managedDirectory(root, input.scope, input.ownerId);
  await mkdir(directory, { recursive: true, mode: 0o750 });
  const canonicalDirectory = await realpath(
    /* turbopackIgnore: true */ directory,
  );
  if (!canonicalDirectory.startsWith(`${root}${path.sep}`))
    throw new ManagedImageError("图片目录无效");
  const filePath = `${canonicalDirectory}${path.sep}${imageId}.webp`;
  const handle = await open(/* turbopackIgnore: true */ filePath, "wx", 0o600);
  try {
    await handle.writeFile(normalized);
  } catch (error) {
    try {
      await unlink(filePath);
    } catch {
      // The original write failure is more useful than a best-effort cleanup failure.
    }
    throw error;
  } finally {
    await handle.close();
  }
  return { key, bytes: normalized.byteLength };
}

export async function readManagedImage(
  key: string | null | undefined,
  scope: ManagedImageScope,
): Promise<Buffer | null> {
  if (!managedImageKeyMatches(key, scope)) return null;
  const root = await managedImageRoot();
  if (!root) return null;
  const [, ownerId, fileName] = key.split("/");
  if (!ownerId || !fileName) return null;
  try {
    const candidate = await realpath(
      /* turbopackIgnore: true */ managedFilePath(
        root,
        scope,
        ownerId,
        fileName,
      ),
    );
    if (!candidate.startsWith(`${root}${path.sep}`)) return null;
    const { readFile } = await import("node:fs/promises");
    return await readFile(/* turbopackIgnore: true */ candidate);
  } catch {
    return null;
  }
}

export async function removeManagedImage(
  key: string,
  scope: ManagedImageScope,
): Promise<void> {
  if (!managedImageKeyMatches(key, scope)) return;
  const root = await managedImageRoot();
  if (!root) return;
  const [, ownerId, fileName] = key.split("/");
  if (!ownerId || !fileName) return;
  try {
    const candidate = await realpath(
      /* turbopackIgnore: true */ managedFilePath(
        root,
        scope,
        ownerId,
        fileName,
      ),
    );
    if (candidate.startsWith(`${root}${path.sep}`)) {
      await unlink(/* turbopackIgnore: true */ candidate);
    }
  } catch {
    // A failed cleanup leaves an unreferenced file. It is safer than deleting a path that did not
    // pass canonical-root validation.
  }
}

export function managedImageKeyMatches(
  key: string | null | undefined,
  scope: ManagedImageScope,
): key is string {
  if (typeof key !== "string") return false;
  const parts = key.split("/");
  if (parts.length !== 3) return false;
  const [keyScope, ownerId, fileName] = parts;
  if (keyScope !== scope || !ownerId || !fileName || !isUuid(ownerId))
    return false;
  if (!fileName.endsWith(".webp")) return false;
  return isUuid(fileName.slice(0, -".webp".length));
}

function decodeBase64Image(value: string): Buffer {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > Math.ceil((MAX_INPUT_BYTES * 4) / 3) + 8
  ) {
    throw new ManagedImageError("图片不能超过 4 MiB");
  }
  if (
    !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) ||
    normalized.length % 4 !== 0
  ) {
    throw new ManagedImageError("图片编码无效");
  }
  const bytes = Buffer.from(normalized, "base64");
  if (
    !bytes.byteLength ||
    bytes.byteLength > MAX_INPUT_BYTES ||
    bytes.toString("base64") !== normalized
  ) {
    throw new ManagedImageError("图片编码无效");
  }
  return bytes;
}

async function normalizeImage(source: Buffer): Promise<Buffer> {
  try {
    const pipeline = sharp(source, {
      animated: false,
      failOn: "warning",
      limitInputPixels: MAX_PIXELS,
    });
    const metadata = await pipeline.metadata();
    if (!metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) {
      throw new Error("unsupported image dimensions");
    }
    const output = await pipeline
      .rotate()
      .resize({
        width: 1024,
        height: 1024,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 88, effort: 4 })
      .toBuffer();
    if (!output.byteLength || output.byteLength > MAX_OUTPUT_BYTES)
      throw new Error("normalized image too large");
    return output;
  } catch {
    throw new ManagedImageError(
      "图片无法安全解码，请上传有效的 JPG、PNG、WebP、AVIF、HEIF 或 GIF 文件",
    );
  }
}

async function managedImageRoot(): Promise<string | null> {
  const storage =
    process.env.MATCHPLANE_HOSTED_MEDIA_ROOT?.trim() ||
    (isProductionEnvironment() ? "" : "/tmp/matchplane-hosted-media");
  if (!storage || !path.isAbsolute(storage)) return null;
  const root = `${storage}${path.sep}managed-images`;
  await mkdir(root, { recursive: true, mode: 0o750 });
  return realpath(/* turbopackIgnore: true */ root);
}

function managedDirectory(
  root: string,
  scope: ManagedImageScope,
  ownerId: string,
): string {
  return `${root}${path.sep}${scope}${path.sep}${ownerId}`;
}

function managedFilePath(
  root: string,
  scope: ManagedImageScope,
  ownerId: string,
  fileName: string,
): string {
  return `${managedDirectory(root, scope, ownerId)}${path.sep}${fileName}`;
}

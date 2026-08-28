import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { normalizeCredentialFile } from "./contract";

export const PLATFORM_ROUTER_SECRET_ROOT =
  "/etc/matchplane/secrets/root-email";

export type PlatformRouterStorageEntry =
  | "active-config"
  | "draft-config"
  | "draft-metadata"
  | "draft-attestation"
  | `credential:${string}`;

export interface ProtectedPlatformRouterStorage {
  read(entry: PlatformRouterStorageEntry): string | null;
  write(entry: PlatformRouterStorageEntry, value: string, label: string): void;
  remove(entry: PlatformRouterStorageEntry): void;
}

export class ProtectedStorageCommitUncertainError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProtectedStorageCommitUncertainError";
  }
}

export interface ProtectedStorageIo {
  open?: typeof openSync;
  write?: typeof writeSync;
  fsync?: typeof fsyncSync;
  rename?: typeof renameSync;
  unlink?: typeof unlinkSync;
  nextId?: () => string;
}

export function credentialStorageEntry(
  credentialFile: string,
): PlatformRouterStorageEntry {
  return `credential:${normalizeCredentialFile(credentialFile)}`;
}

export function createProtectedPlatformRouterStorage(
  root = PLATFORM_ROUTER_SECRET_ROOT,
  io: ProtectedStorageIo = {},
): ProtectedPlatformRouterStorage {
  const opener = io.open ?? openSync;
  const writer = io.write ?? writeSync;
  const sync = io.fsync ?? fsyncSync;
  const rename = io.rename ?? renameSync;
  const unlink = io.unlink ?? unlinkSync;
  const nextId = io.nextId ?? randomUUID;

  function entryPath(entry: PlatformRouterStorageEntry): string {
    switch (entry) {
      case "active-config":
        return path.join(root, "platform-router.json");
      case "draft-config":
        return path.join(root, "platform-router.draft.json");
      case "draft-metadata":
        return path.join(root, "platform-router.draft.meta.json");
      case "draft-attestation":
        return path.join(root, "platform-router.draft.test.json");
      default:
        return path.join(
          root,
          normalizeCredentialFile(entry.slice("credential:".length)),
        );
    }
  }

  return {
    read(entry) {
      const source = entryPath(entry);
      let descriptor: number | null = null;
      try {
        assertRegularPathIfPresent(source);
        descriptor = opener(
          /* turbopackIgnore: true */ source,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        );
        if (!fstatSync(descriptor).isFile()) {
          throw new Error("AI 受保护存储条目不是普通文件");
        }
        const value = readFileSync(
          /* turbopackIgnore: true */ descriptor,
          "utf8",
        ).trim();
        return value || null;
      } catch (cause) {
        if (isNodeErrorCode(cause, "ENOENT")) return null;
        throw new Error("AI 受保护存储无法读取", { cause });
      } finally {
        if (descriptor !== null) closeSync(descriptor);
      }
    },
    write(entry, value, label) {
      const content = value.trim();
      if (!content || content.length > 16_384) {
        throw new Error(`${label}必须为 1..=16384 个字符`);
      }
      const destination = entryPath(entry);
      const temporary = path.join(
        root,
        `.${path.basename(destination)}.${nextId()}.tmp`,
      );
      let descriptor: number | null = null;
      let committed = false;
      try {
        assertTrustedDirectory(root);
        assertRegularPathIfPresent(destination);
        descriptor = opener(
          temporary,
          fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            fsConstants.O_WRONLY |
            fsConstants.O_NOFOLLOW,
          0o640,
        );
        if (!fstatSync(descriptor).isFile()) {
          throw new Error("AI 受保护存储临时条目不是普通文件");
        }
        fchmodSync(descriptor, 0o640);
        writeAll(descriptor, Buffer.from(`${content}\n`), writer);
        sync(descriptor);
        closeSync(descriptor);
        descriptor = null;
        rename(temporary, destination);
        committed = true;
        fsyncDirectory(root, opener, sync);
      } catch (cause) {
        if (descriptor !== null) {
          try {
            closeSync(descriptor);
          } catch {
            // The operation error remains primary; cleanup errors are aggregated below.
          }
        }
        const cleanupError = removeTemporaryFile(temporary, unlink);
        // B2a cannot safely sweep credential-shaped temporary files left by a
        // failed unlink: legacy writers still create the same names without
        // the transaction lock. B2b must add the bounded post-cutover sweep
        // only after every legacy producer is disabled. Keep the failed
        // unlink in the cause chain; neither this error nor its metadata
        // includes the secret bytes written to the temporary file.
        const failure = cleanupError
          ? new AggregateError([asError(cause), cleanupError])
          : cause;
        if (committed) {
          throw new ProtectedStorageCommitUncertainError(
            `${label}已替换但目录同步失败，提交状态不确定`,
            { cause: failure },
          );
        }
        throw new Error(`${label}无法写入受保护存储`, { cause: failure });
      }
    },
    remove(entry) {
      const target = entryPath(entry);
      let committed = false;
      try {
        assertRegularPathIfPresent(target);
        unlink(target);
        committed = true;
        fsyncDirectory(root, opener, sync);
      } catch (cause) {
        if (!committed && isNodeErrorCode(cause, "ENOENT")) return;
        if (committed) {
          throw new ProtectedStorageCommitUncertainError(
            "AI 受保护存储条目已删除但目录同步失败，提交状态不确定",
            { cause },
          );
        }
        throw new Error("AI 受保护存储条目无法删除", { cause });
      }
    },
  };
}

function writeAll(
  descriptor: number,
  bytes: Buffer,
  writer: typeof writeSync,
): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writer(
      descriptor,
      bytes,
      offset,
      bytes.length - offset,
      null,
    );
    if (written <= 0) throw new Error("AI 受保护存储写入返回零字节");
    offset += written;
  }
}

function assertTrustedDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("AI 受保护存储根目录无效");
  }
}

function assertRegularPathIfPresent(target: string): void {
  try {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("AI 受保护存储条目不是普通文件");
    }
  } catch (cause) {
    if (!isNodeErrorCode(cause, "ENOENT")) throw cause;
  }
}

function fsyncDirectory(
  directory: string,
  opener: typeof openSync,
  sync: typeof fsyncSync,
): void {
  const descriptor = opener(
    directory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    sync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function removeTemporaryFile(
  temporary: string,
  unlink: typeof unlinkSync,
): Error | null {
  try {
    unlink(temporary);
    return null;
  } catch (cause) {
    if (isNodeErrorCode(cause, "ENOENT")) return null;
    return asError(cause);
  }
}

function isNodeErrorCode(cause: unknown, code: string): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === code
  );
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { normalizeCredentialFile } from "./contract";

const SECRET_ROOT = "/etc/matchplane/secrets/root-email";

export type PlatformRouterStorageEntry =
  | "active-config"
  | "draft-config"
  | "draft-metadata"
  | "draft-attestation"
  | `credential:${string}`;

export interface ProtectedPlatformRouterStorage {
  read(entry: PlatformRouterStorageEntry): string | null;
  write(
    entry: PlatformRouterStorageEntry,
    value: string,
    label: string,
  ): void;
  remove(entry: PlatformRouterStorageEntry): void;
}

export function credentialStorageEntry(
  credentialFile: string,
): PlatformRouterStorageEntry {
  return `credential:${normalizeCredentialFile(credentialFile)}`;
}

export function createProtectedPlatformRouterStorage(
  root = SECRET_ROOT,
): ProtectedPlatformRouterStorage {
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
      try {
        const value = readFileSync(entryPath(entry), "utf8").trim();
        return value || null;
      } catch (cause) {
        if (isNodeErrorCode(cause, "ENOENT")) return null;
        throw new Error("AI 受保护存储无法读取", { cause });
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
        `.${path.basename(destination)}.${randomUUID()}.tmp`,
      );
      try {
        const descriptor = openSync(temporary, "wx", 0o640);
        try {
          writeFileSync(descriptor, `${content}\n`, "utf8");
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }
        renameSync(temporary, destination);
        chmodSync(destination, 0o640);
      } catch (cause) {
        const cleanupError = removeTemporaryFile(temporary);
        const failure = cleanupError
          ? new AggregateError([asError(cause), cleanupError])
          : cause;
        throw new Error(`${label}无法写入受保护存储`, { cause: failure });
      }
    },
    remove(entry) {
      try {
        unlinkSync(entryPath(entry));
      } catch (cause) {
        if (isNodeErrorCode(cause, "ENOENT")) return;
        throw new Error("AI 受保护存储条目无法删除", { cause });
      }
    },
  };
}

export const protectedPlatformRouterStorage =
  createProtectedPlatformRouterStorage();

function removeTemporaryFile(temporary: string): Error | null {
  try {
    unlinkSync(temporary);
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

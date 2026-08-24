import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createProtectedPlatformRouterStorage,
  credentialStorageEntry,
  ProtectedStorageCommitUncertainError,
} from "./protected-storage";

const WEB_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const TEST_ROOT = path.join(WEB_ROOT, ".scratch", "protected-storage-b1-tests");
const KEY_FILE =
  "platform-router-key-00000000-0000-4000-8000-000000000101.key";
const SENTINEL = "SENTINEL_PRIVATE_VALUE_DO_NOT_LEAK";

beforeAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true, mode: 0o750 });
});

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("protected platform router storage durability", () => {
  it("loops over repeated short writes, fsyncs, and creates exact 0640 files", () => {
    const root = caseRoot("short-write");
    let calls = 0;
    const shortWrite = ((
      descriptor: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      calls += 1;
      return writeSync(
        descriptor,
        buffer,
        offset,
        Math.min(3, length),
        position,
      );
    }) as typeof writeSync;
    const storage = createProtectedPlatformRouterStorage(root, {
      write: shortWrite,
      nextId: () => "00000000-0000-4000-8000-000000000102",
    });

    storage.write(credentialStorageEntry(KEY_FILE), SENTINEL, "API Key");

    expect(calls).toBeGreaterThan(3);
    expect(storage.read(credentialStorageEntry(KEY_FILE))).toBe(SENTINEL);
    expect(statSync(path.join(root, KEY_FILE)).mode & 0o777).toBe(0o640);
    expect(
      createHash("sha256")
        .update(readFileSync(path.join(root, KEY_FILE)))
        .digest("hex"),
    ).toHaveLength(64);
  });

  it("treats a zero-byte write as failure and preserves the previous file", () => {
    const root = caseRoot("zero-write");
    const destination = path.join(root, KEY_FILE);
    const original = "existing-private-value\n";
    writeFileWithMode(destination, original);
    const storage = createProtectedPlatformRouterStorage(root, {
      write: (() => 0) as typeof writeSync,
      nextId: () => "00000000-0000-4000-8000-000000000103",
    });

    expect(() =>
      storage.write(credentialStorageEntry(KEY_FILE), SENTINEL, "API Key"),
    ).toThrow("无法写入受保护存储");
    expect(readFileSync(destination, "utf8")).toBe(original);
  });

  it("preserves the previous credential across rename and pre-publication fsync failures", () => {
    for (const failure of ["rename", "fsync"] as const) {
      const root = caseRoot(`failure-${failure}`);
      const destination = path.join(root, KEY_FILE);
      writeFileWithMode(destination, "existing-private-value\n");
      const denied = Object.assign(new Error(`${failure} denied`), {
        code: failure === "rename" ? "EACCES" : "ENOSPC",
      });
      const storage = createProtectedPlatformRouterStorage(root, {
        rename:
          failure === "rename"
            ? (() => {
                throw denied;
              })
            : undefined,
        fsync:
          failure === "fsync"
            ? (() => {
                throw denied;
              })
            : undefined,
        nextId: () =>
          failure === "rename"
            ? "00000000-0000-4000-8000-000000000104"
            : "00000000-0000-4000-8000-000000000105",
      });

      expect(() =>
        storage.write(credentialStorageEntry(KEY_FILE), SENTINEL, "API Key"),
      ).toThrow("无法写入受保护存储");
      expect(readFileSync(destination, "utf8")).toBe(
        "existing-private-value\n",
      );
    }
  });

  it("reports post-commit directory fsync failures as uncertain for replacement and deletion", () => {
    const writeRoot = caseRoot("uncertain-write");
    const writeDestination = path.join(writeRoot, KEY_FILE);
    writeFileWithMode(writeDestination, "existing-private-value\n");
    const writeStorage = createProtectedPlatformRouterStorage(writeRoot, {
      fsync: ((descriptor: number) => {
        if (fstatSync(descriptor).isDirectory()) {
          throw Object.assign(new Error("directory fsync denied"), { code: "ENOSPC" });
        }
        fsyncSync(descriptor);
      }) as typeof fsyncSync,
    });
    expect(() => writeStorage.write(credentialStorageEntry(KEY_FILE), SENTINEL, "API Key"))
      .toThrow(ProtectedStorageCommitUncertainError);
    expect(readFileSync(writeDestination, "utf8")).toBe(`${SENTINEL}\n`);

    const removeRoot = caseRoot("uncertain-remove");
    const removeDestination = path.join(removeRoot, KEY_FILE);
    writeFileWithMode(removeDestination, "existing-private-value\n");
    const removeStorage = createProtectedPlatformRouterStorage(removeRoot, {
      fsync: (() => {
        throw Object.assign(new Error("directory fsync denied"), { code: "ENOSPC" });
      }) as typeof fsyncSync,
    });
    expect(() => removeStorage.remove(credentialStorageEntry(KEY_FILE)))
      .toThrow(ProtectedStorageCommitUncertainError);
    expect(existsSync(removeDestination)).toBe(false);
  });

  it("refuses symlink credential reads, writes, and removals without following them", () => {
    const root = caseRoot("symlink");
    const outside = path.join(TEST_ROOT, "outside-private-value");
    writeFileWithMode(outside, "outside\n");
    symlinkSync(outside, path.join(root, KEY_FILE));
    const storage = createProtectedPlatformRouterStorage(root);
    const entry = credentialStorageEntry(KEY_FILE);

    expect(() => storage.read(entry)).toThrow("无法读取");
    expect(() => storage.write(entry, SENTINEL, "API Key")).toThrow(
      "无法写入受保护存储",
    );
    expect(() => storage.remove(entry)).toThrow("无法删除");
    expect(readFileSync(outside, "utf8")).toBe("outside\n");
  });
});

function caseRoot(name: string): string {
  const root = path.join(TEST_ROOT, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o750 });
  return root;
}

function writeFileWithMode(target: string, contents: string): void {
  writeFileSync(target, contents, { mode: 0o640 });
  chmodSync(target, 0o640);
}

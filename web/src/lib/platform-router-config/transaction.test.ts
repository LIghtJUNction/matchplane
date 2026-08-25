import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  PLATFORM_ROUTER_AUDIT_FILE,
  type PlatformRouterAuditRecord,
} from "./audit";
import {
  normalizeStoredRouterConfig,
  type StoredRouterConfig,
  type StoredRouterDraft,
} from "./contract";
import {
  acquirePlatformRouterLock,
  checkpointDeliveredAudit,
  commitGeneration,
  flushAuditOutbox,
  garbageCollectPlatformRouterArtifacts,
  MAX_PENDING_AUDIT_RECORDS,
  PLATFORM_ROUTER_GENERATION_DIRECTORY,
  PLATFORM_ROUTER_LOCK_DIRECTORY,
  PLATFORM_ROUTER_LOCK_OWNER_FILE,
  PLATFORM_ROUTER_POINTER_FILE,
  PlatformRouterAuditPendingError,
  PlatformRouterCommitUncertainError,
  PlatformRouterConflictError,
  PlatformRouterCorruptionError,
  PlatformRouterLockOwnershipError,
  PlatformRouterLockTimeoutError,
  PlatformRouterValidationError,
  readCurrentSnapshot,
  recoverPlatformRouterTransactions,
  type PlatformRouterIoOverrides,
  type PlatformRouterLockHandle,
  type PlatformRouterSnapshot,
  type PlatformRouterTransactionOptions,
} from "./transaction";

const WEB_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const TEST_ROOT = path.join(WEB_ROOT, ".scratch", "transaction-b1-tests");
const CHILD_FIXTURE = path.join(
  WEB_ROOT,
  "src/lib/platform-router-config/fixtures/transaction-child.ts",
);
const SENTINEL = "SENTINEL_PRIVATE_VALUE_DO_NOT_LEAK";
const OLD_TIME = new Date("2020-01-01T00:00:00.000Z");
const trackedChildren = new Map<ChildProcess, { stdout: string; stderr: string }>();

interface SwappedCanonicalLock {
  canonical: string;
  original: string;
  replacement: string;
  replacementInode: number;
  replacementOwnerBytes: Buffer;
}

beforeAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true, mode: 0o750 });
});

afterEach(async () => {
  for (const child of trackedChildren.keys()) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await waitForExit(child).catch(() => undefined);
  }
  trackedChildren.clear();
});

afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

describe("identity-safe cross-process lock", () => {
  it("publishes only a fully initialized candidate and ignores an orphan candidate", async () => {
    const root = caseRoot("candidate-publish");
    const orphan = path.join(
      root,
      `.platform-router.tx.lock.candidate-${uuid(1)}`,
    );
    mkdirSync(orphan, { mode: 0o700 });
    writeFileSync(
      path.join(orphan, PLATFORM_ROUTER_LOCK_OWNER_FILE),
      JSON.stringify(staleOwner(1)),
      { mode: 0o600 },
    );
    let checkedPublish = false;
    const handle = await acquirePlatformRouterLock({
      root,
      nextId: idSequence(2),
      io: {
        rename: ((source: string, destination: string) => {
          if (destination.endsWith(PLATFORM_ROUTER_LOCK_DIRECTORY)) {
            checkedPublish = true;
            expect(existsSync(path.join(source, PLATFORM_ROUTER_LOCK_OWNER_FILE))).toBe(true);
            expect(existsSync(destination)).toBe(false);
          }
          renameSync(source, destination);
        }) as typeof renameSync,
      },
    });
    expect(checkedPublish).toBe(true);
    expect(JSON.parse(readFileSync(path.join(root, PLATFORM_ROUTER_LOCK_DIRECTORY, PLATFORM_ROUTER_LOCK_OWNER_FILE), "utf8")).nonce).toBe(handle.owner.nonce);
    expect(existsSync(orphan)).toBe(true);
    handle.release();
  });

  it("preserves a pre-existing candidate on an exact nonce collision", async () => {
    const root = caseRoot("candidate-exact-collision");
    const collision = path.join(
      root,
      `.platform-router.tx.lock.candidate-${uuid(1)}`,
    );
    mkdirSync(collision, { mode: 0o700 });
    const sentinel = Buffer.from("pre-existing-candidate");
    writeFileSync(path.join(collision, "sentinel"), sentinel, { mode: 0o600 });

    const handle = await acquirePlatformRouterLock({
      root,
      nextId: idSequence(1, 2),
    });
    try {
      expect(readFileSync(path.join(collision, "sentinel"))).toEqual(sentinel);
    } finally {
      handle.release();
    }
  });

  it("does not let a paused stale inspector touch a released and recreated lock", async () => {
    const root = caseRoot("stale-aba");
    writeStaleLock(root, 10);
    let resume!: () => void;
    const inspected = new Promise<void>((resolve) => { resume = resolve; });
    let reached!: () => void;
    const reachedBarrier = new Promise<void>((resolve) => { reached = resolve; });
    const c1 = acquirePlatformRouterLock({
      root,
      timeoutMs: 80,
      beforeStaleTakeover: async () => {
        reached();
        await inspected;
      },
    });
    await reachedBarrier;
    const c2 = await acquirePlatformRouterLock({ root, timeoutMs: 500 });
    c2.release();
    const c3 = await acquirePlatformRouterLock({ root, timeoutMs: 500 });
    resume();
    await expect(c1).rejects.toBeInstanceOf(PlatformRouterLockTimeoutError);
    const currentOwner = JSON.parse(readFileSync(path.join(root, PLATFORM_ROUTER_LOCK_DIRECTORY, PLATFORM_ROUTER_LOCK_OWNER_FILE), "utf8"));
    expect(currentOwner.nonce).toBe(c3.owner.nonce);
    c3.release();
  });

  it("uses real child barriers so a paused stale inspector cannot overlap the takeover winner", async () => {
    const root = caseRoot("stale-aba-children");
    writeStaleLock(root, 15);
    const c1Inspected = barrier(root, "c1.inspected");
    const c1Resume = barrier(root, "c1.resume");
    const c1Result = barrier(root, "c1.result");
    const c1 = spawnTrackedChild([
      CHILD_FIXTURE,
      "stale-lock",
      root,
      c1Inspected,
      c1Resume,
      c1Result,
      "250",
    ]);
    await waitForFile(c1Inspected, c1);

    const c2Start = barrier(root, "c2.start");
    const c2Result = barrier(root, "c2.result");
    const c2Release = barrier(root, "c2.release");
    const c2 = spawnTrackedChild([
      CHILD_FIXTURE,
      "lock",
      root,
      c2Start,
      c2Result,
      c2Release,
      "1000",
      "hold",
    ]);
    writeFileSync(c2Start, "go");
    await waitForFile(c2Result, c2);
    expect(JSON.parse(readFileSync(c2Result, "utf8"))).toEqual({ status: "acquired" });

    writeFileSync(c1Resume, "resume");
    await waitForFile(c1Result, c1);
    await waitForExit(c1);
    expect(JSON.parse(readFileSync(c1Result, "utf8"))).toEqual({
      status: "timeout",
      errorName: "PlatformRouterLockTimeoutError",
    });
    expect(c2.exitCode).toBeNull();
    writeFileSync(c2Release, "release");
    await waitForExit(c2);
  }, 20_000);

  it("allows exactly one simultaneous stale takeover contender", async () => {
    const root = caseRoot("takeover-race");
    writeStaleLock(root, 20);
    const contenders = await Promise.allSettled([
      acquirePlatformRouterLock({ root, timeoutMs: 120 }),
      acquirePlatformRouterLock({ root, timeoutMs: 120 }),
    ]);
    const winners = contenders.filter(
      (result): result is PromiseFulfilledResult<PlatformRouterLockHandle> => result.status === "fulfilled",
    );
    expect(winners).toHaveLength(1);
    expect(contenders.filter((result) => result.status === "rejected")).toHaveLength(1);
    winners[0].value.release();
  });

  it("uses a monotonic deadline even when wall time decreases", async () => {
    const root = caseRoot("monotonic-timeout");
    const holder = await acquirePlatformRouterLock({ root });
    let wall = 10_000;
    let monotonic = 0;
    await expect(acquirePlatformRouterLock({
      root,
      timeoutMs: 100,
      nowMs: () => --wall,
      monotonicNowMs: () => { monotonic += 40; return monotonic; },
      sleep: async () => undefined,
    })).rejects.toBeInstanceOf(PlatformRouterLockTimeoutError);
    holder.release();
  });

  it("retries canonical disappearance during inspection and preserves a replacement owner on release", async () => {
    const root = caseRoot("inspection-disappearance");
    const lockPath = path.join(root, PLATFORM_ROUTER_LOCK_DIRECTORY);
    mkdirSync(lockPath, { mode: 0o700 });
    let removed = false;
    const handle = await acquirePlatformRouterLock({
      root,
      timeoutMs: 500,
      io: {
        open: ((target: Parameters<typeof import("node:fs").openSync>[0], flags: Parameters<typeof import("node:fs").openSync>[1], mode?: number) => {
          if (String(target) === lockPath && !removed) {
            removed = true;
            rmSync(lockPath, { recursive: true, force: true });
            throw nodeFailure("ENOENT", "released during inspection");
          }
          return requireOpenSync(target, flags, mode);
        }) as typeof import("node:fs").openSync,
      },
    });
    expect(removed).toBe(true);
    writeFileSync(
      path.join(lockPath, PLATFORM_ROUTER_LOCK_OWNER_FILE),
      JSON.stringify({ ...handle.owner, nonce: uuid(99) }),
      { mode: 0o600 },
    );
    expect(() => handle.release()).toThrow(PlatformRouterLockOwnershipError);
    expect(existsSync(lockPath)).toBe(true);
    rmSync(lockPath, { recursive: true, force: true });
  });

  it("removes the published canonical lock when initial publication fsync fails", async () => {
    const root = caseRoot("publish-fsync-failure");
    const canonical = path.join(root, PLATFORM_ROUTER_LOCK_DIRECTORY);
    let failed = false;
    await expect(acquirePlatformRouterLock({
      root,
      io: pathAwareIo({
        fsync(target, descriptor) {
          if (!failed && target === root && existsSync(canonical)) {
            failed = true;
            throw nodeFailure("ENOSPC", "root fsync failed after publish");
          }
          fsyncSync(descriptor);
        },
      }),
    })).rejects.toThrow("事务锁无法创建");
    expect(failed).toBe(true);
    expect(existsSync(canonical)).toBe(false);
  });

  it("removes a newly installed takeover owner when its directory fsync fails", async () => {
    const root = caseRoot("takeover-fsync-failure");
    const canonical = path.join(root, PLATFORM_ROUTER_LOCK_DIRECTORY);
    writeStaleLock(root, 31);
    let lockFsyncs = 0;
    await expect(acquirePlatformRouterLock({
      root,
      timeoutMs: 500,
      io: pathAwareIo({
        fsync(target, descriptor) {
          if (target === canonical) {
            lockFsyncs += 1;
            if (lockFsyncs === 2) {
              throw nodeFailure("ENOSPC", "takeover owner fsync failed");
            }
          }
          fsyncSync(descriptor);
        },
      }),
    })).rejects.toThrow("takeover owner fsync failed");
    expect(lockFsyncs).toBe(2);
    expect(existsSync(canonical)).toBe(false);
  });

  it("never deletes a replacement directory swapped in during release", async () => {
    const root = caseRoot("release-canonical-swap");
    const canonical = path.join(root, PLATFORM_ROUTER_LOCK_DIRECTORY);
    const original = path.join(root, "parked-original-lock");
    let replacementInode = 0;
    const replacementBytes = Buffer.from(`${JSON.stringify(staleOwner(33))}\n`);
    const handle = await acquirePlatformRouterLock({
      root,
      io: {
        rename: ((source: string, destination: string) => {
          if (
            source === canonical &&
            destination.includes(".platform-router.tx.lock.released-")
          ) {
            renameSync(canonical, original);
            mkdirSync(canonical, { mode: 0o700 });
            writeFileSync(
              path.join(canonical, PLATFORM_ROUTER_LOCK_OWNER_FILE),
              replacementBytes,
              { mode: 0o600 },
            );
            replacementInode = statSync(canonical).ino;
          }
          renameSync(source, destination);
        }) as typeof renameSync,
      },
    });

    expect(() => handle.release()).toThrow(PlatformRouterLockOwnershipError);
    expect(statSync(canonical).ino).toBe(replacementInode);
    expect(readFileSync(path.join(canonical, PLATFORM_ROUTER_LOCK_OWNER_FILE))).toEqual(
      replacementBytes,
    );
    rmSync(canonical, { recursive: true, force: true });
    rmSync(original, { recursive: true, force: true });
  });
});

describe("lock-scoped generation commits", () => {
  it("rejects missing, forged, wrong-root, and lost ownership capabilities", async () => {
    const root = caseRoot("capability");
    const otherRoot = caseRoot("capability-other");
    const handle = await acquirePlatformRouterLock({ root });
    const input = generationInput(101, null, config("one", keyName(1)));
    expect(() => commitGeneration(input, {} as PlatformRouterLockHandle, { root })).toThrow(PlatformRouterLockOwnershipError);
    expect(() => commitGeneration(input, handle, { root: otherRoot })).toThrow(PlatformRouterLockOwnershipError);
    writeFileSync(
      path.join(root, PLATFORM_ROUTER_LOCK_DIRECTORY, PLATFORM_ROUTER_LOCK_OWNER_FILE),
      JSON.stringify({ ...handle.owner, nonce: uuid(102) }),
      { mode: 0o600 },
    );
    expect(() => commitGeneration(input, handle, { root })).toThrow(PlatformRouterLockOwnershipError);
    rmSync(path.join(root, PLATFORM_ROUTER_LOCK_DIRECTORY), { recursive: true, force: true });
  });

  it("rejects owner-byte changes and closes the terminal capability descriptor", async () => {
    const root = caseRoot("capability-owner-bytes");
    const openRootDescriptors = () =>
      readdirSync("/proc/self/fd").filter((entry) => {
        try {
          return readlinkSync(path.join("/proc/self/fd", entry)).startsWith(root);
        } catch {
          return false;
        }
      }).length;
    const baselineDescriptors = openRootDescriptors();
    const handle = await acquirePlatformRouterLock({ root });
    expect(openRootDescriptors()).toBe(baselineDescriptors + 1);
    const ownerPath = path.join(
      root,
      PLATFORM_ROUTER_LOCK_DIRECTORY,
      PLATFORM_ROUTER_LOCK_OWNER_FILE,
    );
    writeFileSync(ownerPath, `${JSON.stringify(handle.owner, null, 2)}\n`, {
      mode: 0o600,
    });
    expect(() =>
      commitGeneration(
        generationInput(105, null, config("same-nonce", keyName(1))),
        handle,
        transactionOptions(root, 105),
      )
    ).toThrow(PlatformRouterLockOwnershipError);
    expect(() => handle.release()).toThrow(PlatformRouterLockOwnershipError);
    expect(openRootDescriptors()).toBe(baselineDescriptors);
    handle.release();
    rmSync(path.join(root, PLATFORM_ROUTER_LOCK_DIRECTORY), {
      recursive: true,
      force: true,
    });
  });

  it("enforces exact parent CAS, rejects self/null/stale parents, and validates parent identity", async () => {
    const root = caseRoot("parent-cas");
    const handle = await acquirePlatformRouterLock({ root });
    try {
      const first = commitGeneration(generationInput(110, null, config("first", keyName(2))), handle, transactionOptions(root, 110));
      expect(() => commitGeneration(generationInput(111, null, config("null", keyName(2))), handle, transactionOptions(root, 111))).toThrow(PlatformRouterConflictError);
      expect(() => commitGeneration(generationInput(112, uuid(112), config("self", keyName(2))), handle, transactionOptions(root, 112))).toThrow(PlatformRouterConflictError);
      const second = commitGeneration(generationInput(113, first.generationId, config("second", keyName(2))), handle, transactionOptions(root, 113));
      expect(() => commitGeneration(generationInput(114, first.generationId, config("stale", keyName(2))), handle, transactionOptions(root, 114))).toThrow(PlatformRouterConflictError);
      expect(existsSync(generationPath(root, 114))).toBe(false);
      writeFileSync(generationPath(root, 113), JSON.stringify({ generationId: uuid(999) }), { mode: 0o640 });
      expect(() => commitGeneration(generationInput(115, second.generationId, config("bad-parent", keyName(2))), handle, transactionOptions(root, 115))).toThrow();
      expect(existsSync(generationPath(root, 115))).toBe(false);
    } finally {
      handle.release();
    }
  });

  it("rechecks both ownership and pointer bytes immediately before publication", async () => {
    const root = caseRoot("pointer-cas-race");
    const handle = await acquirePlatformRouterLock({ root });
    try {
      const first = commitGeneration(generationInput(120, null, config("first", keyName(3))), handle, transactionOptions(root, 120));
      const firstPointer = readFileSync(path.join(root, PLATFORM_ROUTER_POINTER_FILE));
      const second = commitGeneration(generationInput(121, first.generationId, config("second", keyName(3))), handle, transactionOptions(root, 121));
      let swapped = false;
      const io: PlatformRouterIoOverrides = {
        rename: ((source: string, destination: string) => {
          renameSync(source, destination);
          if (!swapped && destination === generationPath(root, 122)) {
            swapped = true;
            writeFileSync(path.join(root, PLATFORM_ROUTER_POINTER_FILE), firstPointer);
          }
        }) as typeof renameSync,
      };
      expect(() => commitGeneration(generationInput(122, second.generationId, config("third", keyName(3))), handle, { ...transactionOptions(root, 122), io })).toThrow(PlatformRouterConflictError);
      expect(readCurrentSnapshot({ root }).generationId).toBe(first.generationId);
    } finally {
      handle.release();
    }
  });

  it("rejects oversized generations, excess pending events, and unbounded attestations before file creation", async () => {
    const root = caseRoot("generation-limits");
    const handle = await acquirePlatformRouterLock({ root });
    try {
      const tooMany = Array.from({ length: MAX_PENDING_AUDIT_RECORDS + 1 }, (_, index) => auditRecord(1_000 + index));
      expect(() => commitGeneration({ ...generationInput(130, null, null), pendingAudit: tooMany }, handle, transactionOptions(root, 130))).toThrow(PlatformRouterValidationError);
      expect(existsSync(generationPath(root, 130))).toBe(false);

      const maximumRecords = Array.from({ length: MAX_PENDING_AUDIT_RECORDS }, (_, index) => auditRecord(3_000 + index, "界".repeat(256)));
      expect(() => commitGeneration({ ...generationInput(131, null, null), pendingAudit: maximumRecords }, handle, transactionOptions(root, 131))).toThrow("超过大小限制");
      expect(existsSync(generationPath(root, 131))).toBe(false);

      const draft: StoredRouterDraft = {
        config: normalizeStoredRouterConfig(config("draft", keyName(4))),
        metadata: { keyChanged: false },
        attestation: {
          digest: "a".repeat(64),
          testedAt: "2026-08-25T00:00:00.000Z",
          requestId: "r".repeat(257),
        },
      };
      expect(() => commitGeneration({ ...generationInput(132, null, null), draft }, handle, transactionOptions(root, 132))).toThrow();
      expect(existsSync(generationPath(root, 132))).toBe(false);
    } finally {
      handle.release();
    }
  });
});

describe("non-destructive audit projection", () => {
  it("leaves a partial tail byte-for-byte intact and reports a retryable pending error", async () => {
    const root = caseRoot("audit-partial");
    const snapshot = await commitState(root, 200, null, null, [auditRecord(200)]);
    const handle = await acquirePlatformRouterLock({ root });
    const auditPath = path.join(root, PLATFORM_ROUTER_AUDIT_FILE);
    const partial = Buffer.from('{"eventId":"partial');
    writeFileSync(auditPath, partial, { mode: 0o640 });
    try {
      expect(() => flushAuditOutbox(snapshot, handle, { root })).toThrow(PlatformRouterAuditPendingError);
      expect(readFileSync(auditPath)).toEqual(partial);
    } finally {
      handle.release();
    }
  });

  it("rejects invalid UTF-8 in a complete line without changing journal bytes", async () => {
    const root = caseRoot("audit-utf8");
    const snapshot = await commitState(root, 201, null, null, [auditRecord(201)]);
    const handle = await acquirePlatformRouterLock({ root });
    const bytes = Buffer.from([0x7b, 0xff, 0x7d, 0x0a]);
    const auditPath = path.join(root, PLATFORM_ROUTER_AUDIT_FILE);
    writeFileSync(auditPath, bytes, { mode: 0o640 });
    try {
      expect(() => flushAuditOutbox(snapshot, handle, { root })).toThrow(PlatformRouterCorruptionError);
      expect(readFileSync(auditPath)).toEqual(bytes);
    } finally {
      handle.release();
    }
  });

  it("classifies impossible unterminated UTF-8 as corruption and a truncated multibyte suffix as pending", async () => {
    const root = caseRoot("audit-utf8-tail");
    const snapshot = await commitState(root, 204, null, null, [auditRecord(204)]);
    const handle = await acquirePlatformRouterLock({ root });
    const auditPath = path.join(root, PLATFORM_ROUTER_AUDIT_FILE);
    try {
      const invalid = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff]);
      writeFileSync(auditPath, invalid, { mode: 0o640 });
      expect(() => flushAuditOutbox(snapshot, handle, { root })).toThrow(
        PlatformRouterCorruptionError,
      );
      expect(readFileSync(auditPath)).toEqual(invalid);

      const truncated = Buffer.concat([
        Buffer.from('{"actor":"'),
        Buffer.from([0xe7, 0x95]),
      ]);
      writeFileSync(auditPath, truncated, { mode: 0o640 });
      expect(() => flushAuditOutbox(snapshot, handle, { root })).toThrow(
        PlatformRouterAuditPendingError,
      );
      expect(readFileSync(auditPath)).toEqual(truncated);
    } finally {
      handle.release();
    }
  });

  it("decodes valid UTF-8 even when a multibyte character crosses the scan chunk boundary", async () => {
    const root = caseRoot("audit-utf8-split");
    const event = auditRecord(205);
    const snapshot = await commitState(root, 205, null, null, [event]);
    const prefix = `${JSON.stringify(auditRecord(206))}\n`;
    const scanChunkBytes = 64 * 1024;
    const template = JSON.stringify({ ...event, padding: "界" });
    const characterIndex = template.indexOf("界");
    const fixedOffset = Buffer.byteLength(`${prefix}${template.slice(0, characterIndex)}`);
    const paddingLength = (scanChunkBytes - 1 - (fixedOffset % scanChunkBytes) + scanChunkBytes)
      % scanChunkBytes;
    const line = JSON.stringify({ ...event, padding: `${"x".repeat(paddingLength)}界` });
    const characterOffset = Buffer.byteLength(`${prefix}${line.slice(0, line.indexOf("界"))}`);
    expect(characterOffset % scanChunkBytes).toBe(scanChunkBytes - 1);
    writeFileSync(path.join(root, PLATFORM_ROUTER_AUDIT_FILE), `${prefix}${line}\n`, { mode: 0o640 });
    const handle = await acquirePlatformRouterLock({ root });
    try {
      expect(flushAuditOutbox(snapshot, handle, { root }).appendedEventIds).toEqual([]);
    } finally {
      handle.release();
    }
  });

  it("never truncates a child appender paused after a positive short append", async () => {
    const root = caseRoot("audit-child-partial");
    const event = auditRecord(202);
    const snapshot = await commitState(root, 202, null, null, [event]);
    const auditPath = path.join(root, PLATFORM_ROUTER_AUDIT_FILE);
    const paused = barrier(root, "audit.paused");
    const resume = barrier(root, "audit.resume");
    const done = barrier(root, "audit.done");
    const child = spawnTrackedChild([
      CHILD_FIXTURE,
      "audit-short-append",
      auditPath,
      paused,
      resume,
      done,
      JSON.stringify(event),
    ]);
    await waitForFile(paused, child);
    const firstLength = Number(readFileSync(paused, "utf8"));
    const fullLine = Buffer.from(`${JSON.stringify(event)}\n`);
    expect(readFileSync(auditPath)).toEqual(fullLine.subarray(0, firstLength));

    const handle = await acquirePlatformRouterLock({ root });
    try {
      expect(() => flushAuditOutbox(snapshot, handle, { root })).toThrow(PlatformRouterAuditPendingError);
      expect(readFileSync(auditPath)).toEqual(fullLine.subarray(0, firstLength));
      writeFileSync(resume, "resume");
      await waitForFile(done, child);
      await waitForExit(child);
      const replay = flushAuditOutbox(snapshot, handle, { root });
      expect(replay.appendedEventIds).toEqual([]);
      expect(readFileSync(auditPath)).toEqual(fullLine);
    } finally {
      handle.release();
    }
  }, 20_000);

  it("preserves a positive mid-record append after the next write fails", async () => {
    const root = caseRoot("audit-mid-record-failure");
    const event = auditRecord(207);
    const snapshot = await commitState(root, 207, null, null, [event]);
    const handle = await acquirePlatformRouterLock({ root });
    const auditPath = path.join(root, PLATFORM_ROUTER_AUDIT_FILE);
    const fullLine = Buffer.from(`${JSON.stringify(event)}\n`);
    let writes = 0;
    const partialThenFail = ((
      descriptor: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      writes += 1;
      if (writes === 1) {
        return writeSync(descriptor, buffer, offset, Math.min(11, length), position);
      }
      throw nodeFailure("ENOSPC", "audit append ran out of space");
    }) as typeof writeSync;
    try {
      expect(() =>
        flushAuditOutbox(snapshot, handle, {
          root,
          io: { write: partialThenFail },
        })
      ).toThrow("审计投影失败");
      const partial = readFileSync(auditPath);
      expect(partial.length).toBeGreaterThan(0);
      expect(partial.length).toBeLessThan(fullLine.length);
      expect(partial).toEqual(fullLine.subarray(0, partial.length));
      expect(readCurrentSnapshot({ root }).pendingAudit).toEqual([event]);
      expect(() => flushAuditOutbox(snapshot, handle, { root })).toThrow(
        PlatformRouterAuditPendingError,
      );
      expect(readFileSync(auditPath)).toEqual(partial);
    } finally {
      handle.release();
    }
  });

  it("fails before append when the canonical lock is swapped after audit scanning", async () => {
    const root = caseRoot("audit-lock-swap");
    const event = auditRecord(208);
    const snapshot = await commitState(root, 208, null, null, [event]);
    const auditPath = path.join(root, PLATFORM_ROUTER_AUDIT_FILE);
    const originalAudit = Buffer.from(`${JSON.stringify(auditRecord(209))}\n`);
    writeFileSync(auditPath, originalAudit, { mode: 0o640 });
    const handle = await acquirePlatformRouterLock({ root });
    const canonical = path.join(root, PLATFORM_ROUTER_LOCK_DIRECTORY);
    let lockChecks = 0;
    let swapped: SwappedCanonicalLock | null = null;
    try {
      expect(() => flushAuditOutbox(snapshot, handle, {
        root,
        io: {
          lstat: ((target: string) => {
            if (target === canonical) {
              lockChecks += 1;
              if (lockChecks === 2) {
                swapped = swapCanonicalLock(root, "audit", 209);
              }
            }
            return lstatSync(target);
          }) as typeof lstatSync,
        },
      })).toThrow(PlatformRouterLockOwnershipError);
      expect(swapped).not.toBeNull();
      expect(readFileSync(auditPath)).toEqual(originalAudit);
      expectCanonicalReplacementUntouched(swapped!);
    } finally {
      if (swapped) restoreCanonicalLock(swapped, handle);
      else handle.release();
    }
  });

  it("loops positive short appends, deduplicates, and checkpoints under one owner", async () => {
    const root = caseRoot("audit-short-write");
    const event = auditRecord(202);
    const snapshot = await commitState(root, 202, null, null, [event]);
    const handle = await acquirePlatformRouterLock({ root });
    let writes = 0;
    const shortWrite = ((descriptor: number, buffer: Uint8Array, offset: number, length: number, position: number | null) => {
      writes += 1;
      return writeSync(descriptor, buffer, offset, Math.min(7, length), position);
    }) as typeof writeSync;
    try {
      const flush = flushAuditOutbox(snapshot, handle, { root, io: { write: shortWrite } });
      expect(writes).toBeGreaterThan(1);
      expect(flush.appendedEventIds).toEqual([event.eventId]);
      expect(flushAuditOutbox(snapshot, handle, { root }).appendedEventIds).toEqual([]);
      const checkpoint = checkpointDeliveredAudit(snapshot, flush.deliveredEventIds, handle, transactionOptions(root, 203));
      expect(checkpoint.pendingAudit).toEqual([]);
      expect(readFileSync(path.join(root, PLATFORM_ROUTER_AUDIT_FILE), "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      handle.release();
    }
  });
});

describe("reader and garbage-collection integrity", () => {
  it("makes a real lock-free reader observe nonempty old and new whole snapshots", async () => {
    const root = caseRoot("reader-race");
    const key = keyName(5);
    let current = await commitState(root, 300, null, config("race-model-0", key));
    const start = barrier(root, "reader.start");
    const stop = barrier(root, "reader.stop");
    const result = barrier(root, "reader.result");
    const reader = spawnTrackedChild([CHILD_FIXTURE, "race-read", root, start, stop, result]);
    writeFileSync(start, "go");
    await waitForFile(`${start}.ready`, reader);
    for (let index = 1; index <= 8; index += 1) {
      current = await commitState(root, 300 + index, current.generationId, config(`race-model-${index}`, key));
      await delay(8);
    }
    await delay(50);
    writeFileSync(stop, "stop");
    await waitForFile(result, reader);
    await waitForExit(reader);
    const observed = JSON.parse(readFileSync(result, "utf8")) as { models: string[]; errors: string[] };
    expect(observed.errors).toEqual([]);
    expect(observed.models.length).toBeGreaterThan(1);
    expect(observed.models).toContain("race-model-0");
    expect(observed.models).toContain("race-model-8");
  }, 20_000);

  it("fails closed on self-cycle, multi-node cycle, and missing retained parents", async () => {
    for (const [name, mutate] of [
      ["self", (generation: Record<string, unknown>) => { generation.parentGenerationId = generation.generationId; }],
      ["multi", (generation: Record<string, unknown>) => { generation.parentGenerationId = uuid(401); }],
      ["missing", (generation: Record<string, unknown>) => { generation.parentGenerationId = uuid(499); }],
    ] as const) {
      const root = caseRoot(`gc-${name}`);
      const first = await commitState(root, 400, null, config("one", keyName(6)));
      const second = await commitState(root, 401, first.generationId, config("two", keyName(6)));
      const third = await commitState(root, 402, second.generationId, config("three", keyName(6)));
      const targetNumber = name === "multi" ? 400 : 402;
      rewriteGenerationAndPointer(root, targetNumber, third.generationId === uuid(targetNumber), mutate);
      const handle = await acquirePlatformRouterLock({ root });
      try {
        expect(() => garbageCollectPlatformRouterArtifacts(handle, { root, gcGraceMs: 0 })).toThrow();
      } finally {
        handle.release();
      }
    }
  });

  it("validates missing parents and cycles beyond the retention window before deleting anything", async () => {
    for (const [name, base, badParent] of [
      ["deep-missing", 410, uuid(499)],
      ["deep-cycle", 420, uuid(423)],
    ] as const) {
      const root = caseRoot(`gc-${name}`);
      let parent: string | null = null;
      for (let index = 0; index < 5; index += 1) {
        const snapshot = await commitState(
          root,
          base + index,
          parent,
          config(`${name}-${index}`, keyName(base + index)),
        );
        parent = snapshot.generationId;
      }
      rewriteGenerationAndPointer(root, base, false, (generation) => {
        generation.parentGenerationId = badParent;
      });
      const orphan = keyName(base + 50);
      writeCredential(root, orphan, "must-survive-failed-gc");
      utimesSync(path.join(root, orphan), OLD_TIME, OLD_TIME);
      const generationFiles = readdirSync(
        path.join(root, PLATFORM_ROUTER_GENERATION_DIRECTORY),
      );
      const generationBytes = generationFiles.map((entry) =>
        readFileSync(path.join(root, PLATFORM_ROUTER_GENERATION_DIRECTORY, entry))
      );

      const handle = await acquirePlatformRouterLock({ root });
      try {
        expect(() =>
          garbageCollectPlatformRouterArtifacts(handle, {
            root,
            gcGraceMs: 0,
          })
        ).toThrow(PlatformRouterCorruptionError);
        expect(existsSync(path.join(root, orphan))).toBe(true);
        expect(readdirSync(path.join(root, PLATFORM_ROUTER_GENERATION_DIRECTORY))).toEqual(
          generationFiles,
        );
        for (const [index, entry] of generationFiles.entries()) {
          expect(
            readFileSync(path.join(root, PLATFORM_ROUTER_GENERATION_DIRECTORY, entry)),
          ).toEqual(generationBytes[index]);
        }
      } finally {
        handle.release();
      }
    }
  });

  it("fails before credential deletion when the canonical lock is swapped after GC scanning", async () => {
    const root = caseRoot("gc-lock-swap");
    const currentKey = keyName(460);
    const orphan = keyName(461);
    writeCredential(root, currentKey, "current-private-value");
    writeCredential(root, orphan, "orphan-private-value");
    await commitState(root, 460, null, config("gc-lock-swap", currentKey));
    utimesSync(path.join(root, orphan), OLD_TIME, OLD_TIME);
    const handle = await acquirePlatformRouterLock({ root });
    const canonical = path.join(root, PLATFORM_ROUTER_LOCK_DIRECTORY);
    let lockChecks = 0;
    let swapped: SwappedCanonicalLock | null = null;
    try {
      expect(() => garbageCollectPlatformRouterArtifacts(handle, {
        root,
        gcGraceMs: 0,
        io: {
          lstat: ((target: string) => {
            if (target === canonical) {
              lockChecks += 1;
              if (lockChecks === 2) {
                swapped = swapCanonicalLock(root, "gc", 461);
              }
            }
            return lstatSync(target);
          }) as typeof lstatSync,
        },
      })).toThrow(PlatformRouterLockOwnershipError);
      expect(swapped).not.toBeNull();
      expect(existsSync(path.join(root, orphan))).toBe(true);
      expectCanonicalReplacementUntouched(swapped!);
    } finally {
      if (swapped) restoreCanonicalLock(swapped, handle);
      else handle.release();
    }
  });

  it("imports legacy state and completes recovery while retaining no secret in public artifacts", async () => {
    const root = caseRoot("legacy-recovery");
    const key = keyName(7);
    writeFileSync(path.join(root, "platform-router.json"), JSON.stringify(config("legacy", key)), { mode: 0o640 });
    writeFileSync(path.join(root, key), "private-value", { mode: 0o640 });
    const result = await recoverPlatformRouterTransactions({ root });
    expect(result.importedLegacy).toBe(true);
    expect(result.snapshot.active?.model).toBe("legacy");
    for (const entry of readdirSync(root)) {
      if (entry === key || entry === "platform-router.json" || entry === PLATFORM_ROUTER_LOCK_DIRECTORY) continue;
      const target = path.join(root, entry);
      if (lstatSync(target).isFile()) expect(readFileSync(target, "utf8")).not.toContain("private-value");
    }
  });
});

describe("ported immutable generation invariants", () => {
  it("verifies checksums and modes, rejects symlink/non-regular artifacts, and uses legacy only when the pointer is absent", async () => {
    const root = caseRoot("ported-generation-read");
    const key = keyName(601);
    writeCredential(root, key, SENTINEL);
    await commitState(root, 611, null, config("model-one", key));
    const directory = path.join(root, PLATFORM_ROUTER_GENERATION_DIRECTORY);
    const generation = generationPath(root, 611);
    const pointer = path.join(root, PLATFORM_ROUTER_POINTER_FILE);
    expect(readCurrentSnapshot({ root }).active?.model).toBe("model-one");
    expect(statSync(directory).mode & 0o777).toBe(0o750);
    expect(statSync(generation).mode & 0o777).toBe(0o640);
    expect(statSync(pointer).mode & 0o777).toBe(0o640);

    const generationBytes = readFileSync(generation);
    writeFileSync(generation, Buffer.concat([generationBytes, Buffer.from(" ")]));
    expect(() => readCurrentSnapshot({ root })).toThrow(PlatformRouterCorruptionError);
    writeFileSync(generation, generationBytes, { mode: 0o640 });

    const outsideGeneration = path.join(TEST_ROOT, "outside-generation");
    writeFileSync(outsideGeneration, generationBytes, { mode: 0o640 });
    unlinkSync(generation);
    symlinkSync(outsideGeneration, generation);
    expect(() => readCurrentSnapshot({ root })).toThrow(PlatformRouterCorruptionError);
    unlinkSync(generation);
    mkdirSync(generation);
    expect(() => readCurrentSnapshot({ root })).toThrow(PlatformRouterCorruptionError);
    rmSync(generation, { recursive: true });
    writeFileSync(generation, generationBytes, { mode: 0o640 });

    const pointerBytes = readFileSync(pointer);
    writeFileSync(pointer, "{broken\n", { mode: 0o640 });
    writeFileSync(
      path.join(root, "platform-router.json"),
      JSON.stringify(config("legacy-must-not-win", key)),
      { mode: 0o640 },
    );
    expect(() => readCurrentSnapshot({ root })).toThrow(PlatformRouterCorruptionError);
    writeFileSync(pointer, pointerBytes, { mode: 0o640 });
    unlinkSync(pointer);
    expect(readCurrentSnapshot({ root })).toMatchObject({
      source: "legacy",
      active: { model: "legacy-must-not-win" },
    });

    const outsidePointer = path.join(TEST_ROOT, "outside-pointer");
    writeFileSync(outsidePointer, pointerBytes, { mode: 0o640 });
    symlinkSync(outsidePointer, pointer);
    expect(() => readCurrentSnapshot({ root })).toThrow(PlatformRouterCorruptionError);
    unlinkSync(pointer);
    mkdirSync(pointer);
    expect(() => readCurrentSnapshot({ root })).toThrow(PlatformRouterCorruptionError);
  });

  it("preserves authoritative state across full/zero writes and every pre-pointer crash boundary", async () => {
    const root = caseRoot("ported-crash-boundaries");
    const oldKey = keyName(620);
    const newKey = keyName(621);
    writeCredential(root, oldKey, "old-private-value");
    writeCredential(root, newKey, SENTINEL);
    const old = await commitState(root, 622, null, config("old-model", oldKey));

    let shortWriteCalls = 0;
    const shortWrite = ((
      descriptor: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      shortWriteCalls += 1;
      return writeSync(descriptor, buffer, offset, Math.min(7, length), position);
    }) as typeof writeSync;
    const authoritative = await commitState(
      root,
      623,
      old.generationId,
      config("short-write-model", newKey),
      [],
      { io: { write: shortWrite } },
    );
    expect(shortWriteCalls).toBeGreaterThan(10);
    expect(readCurrentSnapshot({ root }).generationId).toBe(authoritative.generationId);

    await expectCommitFailureKeeps(root, authoritative, 624, config("zero-write", newKey), {
      write: (() => 0) as typeof writeSync,
    });
    await expectCommitFailureKeeps(
      root,
      authoritative,
      625,
      config("generation-file-fsync", newKey),
      pathAwareIo({
        fsync(target, descriptor) {
          if (target.includes(PLATFORM_ROUTER_GENERATION_DIRECTORY) && target.endsWith(".tmp")) {
            throw nodeFailure("ENOSPC", "generation file fsync full");
          }
          fsyncSync(descriptor);
        },
      }),
    );
    await expectCommitFailureKeeps(
      root,
      authoritative,
      626,
      config("generation-dir-fsync", newKey),
      pathAwareIo({
        fsync(target, descriptor) {
          if (target === path.join(root, PLATFORM_ROUTER_GENERATION_DIRECTORY)) {
            throw nodeFailure("ENOSPC", "generation directory fsync full");
          }
          fsyncSync(descriptor);
        },
      }),
    );
    await expectCommitFailureKeeps(root, authoritative, 627, config("pointer-write", newKey), {
      open: ((target, flags, mode) => {
        if (String(target).includes(".platform-router.current.")) {
          throw nodeFailure("EACCES", "pointer write denied");
        }
        return importOpenSync(target, flags, mode);
      }) as typeof importOpenSync,
    });
    await expectCommitFailureKeeps(root, authoritative, 628, config("pointer-rename", newKey), {
      rename: ((source: string, destination: string) => {
        if (destination.endsWith(PLATFORM_ROUTER_POINTER_FILE)) {
          throw nodeFailure("EACCES", "pointer rename denied");
        }
        renameSync(source, destination);
      }) as typeof renameSync,
    });
  });

  it("reports pointer-publication fsync uncertainty and treats the new state as authoritative and immutable", async () => {
    const root = caseRoot("ported-commit-uncertain");
    const key = keyName(630);
    writeCredential(root, key, SENTINEL);
    const old = await commitState(root, 631, null, config("old-model", key));
    let pointerRenamed = false;
    const uncertainIo = pathAwareIo({
      rename(source, destination) {
        renameSync(source, destination);
        if (destination.endsWith(PLATFORM_ROUTER_POINTER_FILE)) pointerRenamed = true;
      },
      fsync(target, descriptor) {
        if (pointerRenamed && target === root) {
          throw nodeFailure("ENOSPC", "root directory fsync full");
        }
        fsyncSync(descriptor);
      },
    });
    await expect(
      commitState(
        root,
        632,
        old.generationId,
        config("committed-uncertain", key),
        [],
        { io: uncertainIo },
      ),
    ).rejects.toBeInstanceOf(PlatformRouterCommitUncertainError);
    expect(readCurrentSnapshot({ root })).toMatchObject({
      generationId: uuid(632),
      active: { model: "committed-uncertain" },
    });
    await expect(
      commitState(root, 632, old.generationId, config("must-not-overwrite", key)),
    ).rejects.toThrow();
    expect(readCurrentSnapshot({ root }).active?.model).toBe("committed-uncertain");
  });
});

describe("ported audit durability invariants", () => {
  it("streams and dedupes a journal larger than 1 MiB under the owned lock", async () => {
    const root = caseRoot("ported-audit-large");
    const existing = auditRecord(700);
    const missing = auditRecord(701);
    const snapshot = await commitState(root, 702, null, null, [existing, missing]);
    const historical = Array.from({ length: 5_000 }, (_, index) =>
      JSON.stringify(auditRecord(10_000 + index)),
    );
    const journal = `${historical.join("\n")}\n${JSON.stringify(existing)}\n`;
    expect(Buffer.byteLength(journal)).toBeGreaterThan(1024 * 1024);
    const auditPath = path.join(root, PLATFORM_ROUTER_AUDIT_FILE);
    writeFileSync(auditPath, journal, { mode: 0o640 });
    const handle = await acquirePlatformRouterLock({ root });
    try {
      const replay = flushAuditOutbox(snapshot, handle, { root });
      expect(replay.appendedEventIds).toEqual([missing.eventId]);
      const matching = readFileSync(auditPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).eventId)
        .filter((eventId) => eventId === existing.eventId || eventId === missing.eventId);
      expect(matching).toEqual([existing.eventId, missing.eventId]);
      expect(
        checkpointDeliveredAudit(
          snapshot,
          replay.deliveredEventIds,
          handle,
          transactionOptions(root, 703),
        ).pendingAudit,
      ).toEqual([]);
    } finally {
      handle.release();
    }
  });

  it("rejects oversized complete records, malformed complete lines, and duplicate-content conflicts without mutation", async () => {
    const oversizedRoot = caseRoot("ported-audit-oversized");
    const event = auditRecord(710);
    const oversizedSnapshot = await commitState(oversizedRoot, 711, null, null, [event]);
    const oversizedPath = path.join(oversizedRoot, PLATFORM_ROUTER_AUDIT_FILE);
    const oversized = `${JSON.stringify({ ...auditRecord(712), padding: "x".repeat(70 * 1024) })}\n`;
    writeFileSync(oversizedPath, oversized, { mode: 0o640 });
    const oversizedHandle = await acquirePlatformRouterLock({ root: oversizedRoot });
    try {
      expect(() => flushAuditOutbox(oversizedSnapshot, oversizedHandle, { root: oversizedRoot })).toThrow("单条记录过大");
      expect(readFileSync(oversizedPath, "utf8")).toBe(oversized);
    } finally {
      oversizedHandle.release();
    }

    const malformedRoot = caseRoot("ported-audit-malformed");
    const malformedSnapshot = await commitState(malformedRoot, 713, null, null, [event]);
    const malformedPath = path.join(malformedRoot, PLATFORM_ROUTER_AUDIT_FILE);
    writeFileSync(malformedPath, "{complete-but-invalid}\n", { mode: 0o640 });
    const malformedHandle = await acquirePlatformRouterLock({ root: malformedRoot });
    try {
      expect(() => flushAuditOutbox(malformedSnapshot, malformedHandle, { root: malformedRoot })).toThrow("完整的无效记录");
      expect(readFileSync(malformedPath, "utf8")).toBe("{complete-but-invalid}\n");
    } finally {
      malformedHandle.release();
    }

    const conflictRoot = caseRoot("ported-audit-content-conflict");
    const conflictSnapshot = await commitState(conflictRoot, 714, null, null, [event]);
    const conflicting = { ...event, model: "different-model" };
    const conflictJournal = `${JSON.stringify(conflicting)}\n`;
    const conflictPath = path.join(conflictRoot, PLATFORM_ROUTER_AUDIT_FILE);
    writeFileSync(conflictPath, conflictJournal, { mode: 0o640 });
    const conflictHandle = await acquirePlatformRouterLock({ root: conflictRoot });
    try {
      expect(() => flushAuditOutbox(conflictSnapshot, conflictHandle, { root: conflictRoot })).toThrow("内容冲突");
      expect(readFileSync(conflictPath, "utf8")).toBe(conflictJournal);
    } finally {
      conflictHandle.release();
    }
  });

  it("dedupes a journal-fsynced event after checkpoint pointer failure, then checkpoints exactly once", async () => {
    const root = caseRoot("ported-checkpoint-failure");
    const event = auditRecord(720);
    const snapshot = await commitState(root, 721, null, null, [event]);
    const handle = await acquirePlatformRouterLock({ root });
    try {
      const flushed = flushAuditOutbox(snapshot, handle, { root });
      const pointerDenied: PlatformRouterIoOverrides = {
        rename: ((source: string, destination: string) => {
          if (destination.endsWith(PLATFORM_ROUTER_POINTER_FILE)) {
            throw nodeFailure("EACCES", "checkpoint pointer denied");
          }
          renameSync(source, destination);
        }) as typeof renameSync,
      };
      expect(() =>
        checkpointDeliveredAudit(snapshot, flushed.deliveredEventIds, handle, {
          ...transactionOptions(root, 722),
          io: pointerDenied,
        }),
      ).toThrow();
      expect(readCurrentSnapshot({ root }).pendingAudit).toHaveLength(1);
      const replay = flushAuditOutbox(readCurrentSnapshot({ root }), handle, { root });
      expect(replay.appendedEventIds).toEqual([]);
      const checkpoint = checkpointDeliveredAudit(
        readCurrentSnapshot({ root }),
        replay.deliveredEventIds,
        handle,
        transactionOptions(root, 723),
      );
      expect(checkpoint.pendingAudit).toEqual([]);
      expect(readFileSync(path.join(root, PLATFORM_ROUTER_AUDIT_FILE), "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      handle.release();
    }
  });
});

describe("ported recovery and collection invariants", () => {
  it("imports byte-identical legacy files, excludes secrets from all public artifacts/errors, and fails closed on credential symlinks", async () => {
    const root = caseRoot("ported-legacy-recovery");
    const key = keyName(801);
    const activeRaw = `${JSON.stringify(config("legacy-active", key))}\n`;
    const draftRaw = `${JSON.stringify(config("legacy-draft", key))}\n`;
    writeFileSync(path.join(root, "platform-router.json"), activeRaw, { mode: 0o640 });
    writeFileSync(path.join(root, "platform-router.draft.json"), draftRaw, { mode: 0o640 });
    writeFileSync(path.join(root, "platform-router.draft.meta.json"), '{"keyChanged":true}\n', { mode: 0o640 });
    writeFileSync(
      path.join(root, "platform-router.draft.test.json"),
      `${JSON.stringify({ digest: "a".repeat(64), testedAt: "2026-08-25T00:00:00.000Z", requestId: "legacy-request" })}\n`,
      { mode: 0o640 },
    );
    writeCredential(root, key, SENTINEL);
    const hashesBefore = legacyHashes(root);
    const generationDirectory = path.join(root, PLATFORM_ROUTER_GENERATION_DIRECTORY);
    mkdirSync(generationDirectory, { mode: 0o750 });
    const generationTemp = `.${uuid(803)}.${uuid(804)}.tmp`;
    const pointerTemp = `.platform-router.current.${uuid(805)}.tmp`;
    writeFileSync(path.join(generationDirectory, generationTemp), "orphan", { mode: 0o640 });
    writeFileSync(path.join(root, pointerTemp), "orphan", { mode: 0o640 });
    writeFileSync(path.join(root, "operator-note.keep"), "keep", { mode: 0o640 });
    const result = await recoverPlatformRouterTransactions({ root });
    expect(result.importedLegacy).toBe(true);
    expect(result.snapshot).toMatchObject({
      active: { model: "legacy-active" },
      draft: { config: { model: "legacy-draft" } },
    });
    expect(legacyHashes(root)).toEqual(hashesBefore);
    // B2b-web leaves recognized temp orphans for the B2b-ops post-drain cleanup;
    // a pre-cutover process could still be writing either file during rollout.
    expect(existsSync(path.join(generationDirectory, generationTemp))).toBe(true);
    expect(existsSync(path.join(root, pointerTemp))).toBe(true);
    expect(existsSync(path.join(root, "operator-note.keep"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    for (const artifact of [
      path.join(root, PLATFORM_ROUTER_POINTER_FILE),
      path.join(root, PLATFORM_ROUTER_AUDIT_FILE),
      ...readdirSync(path.join(root, PLATFORM_ROUTER_GENERATION_DIRECTORY)).map((entry) =>
        path.join(root, PLATFORM_ROUTER_GENERATION_DIRECTORY, entry),
      ),
    ]) {
      if (existsSync(artifact) && lstatSync(artifact).isFile()) {
        expect(readFileSync(artifact, "utf8")).not.toContain(SENTINEL);
      }
    }

    const symlinkRoot = caseRoot("ported-legacy-symlink");
    const symlinkKey = keyName(802);
    writeFileSync(
      path.join(symlinkRoot, "platform-router.json"),
      JSON.stringify(config("legacy-active", symlinkKey)),
      { mode: 0o640 },
    );
    const outside = path.join(TEST_ROOT, "outside-credential");
    writeCredential(TEST_ROOT, path.basename(outside), SENTINEL);
    symlinkSync(outside, path.join(symlinkRoot, symlinkKey));
    let recoveryError: unknown;
    try {
      await recoverPlatformRouterTransactions({ root: symlinkRoot });
    } catch (cause) {
      recoveryError = cause;
    }
    expect(recoveryError).toBeInstanceOf(PlatformRouterCorruptionError);
    expect(String(recoveryError)).not.toContain(SENTINEL);
    expect(existsSync(path.join(symlinkRoot, PLATFORM_ROUTER_POINTER_FILE))).toBe(false);
  });

  it("keeps current plus two predecessors, grace generations, all referenced and legacy keys, and never removes platform-router.key", async () => {
    const root = caseRoot("ported-gc");
    const snapshots: PlatformRouterSnapshot[] = [];
    let parent: string | null = null;
    for (let index = 1; index <= 5; index += 1) {
      const key = keyName(820 + index);
      writeCredential(root, key, `private-value-${index}`);
      const snapshot = await commitState(root, 830 + index, parent, config(`gc-model-${index}`, key));
      snapshots.push(snapshot);
      parent = snapshot.generationId;
    }
    const pointerBeforeGrace = readFileSync(path.join(root, PLATFORM_ROUTER_POINTER_FILE));
    const graceKey = keyName(826);
    writeCredential(root, graceKey, "grace-private-value");
    await commitState(root, 836, parent, config("grace-orphan", graceKey));
    writeFileSync(path.join(root, PLATFORM_ROUTER_POINTER_FILE), pointerBeforeGrace, { mode: 0o640 });

    const draftKey = keyName(827);
    writeCredential(root, draftKey, "draft-private-value");
    const current = readCurrentSnapshot({ root });
    const handleForDraft = await acquirePlatformRouterLock({ root });
    try {
      const draft: StoredRouterDraft = {
        config: normalizeStoredRouterConfig(config("draft-model", draftKey)),
        metadata: { keyChanged: true },
        attestation: null,
      };
      await Promise.resolve(commitGeneration(
        {
          generationId: uuid(837),
          parentGenerationId: current.generationId,
          active: current.active,
          draft,
          pendingAudit: [],
        },
        handleForDraft,
        transactionOptions(root, 837),
      ));
    } finally {
      handleForDraft.release();
    }
    const pointerWithDraft = readFileSync(path.join(root, PLATFORM_ROUTER_POINTER_FILE));

    const legacyKey = keyName(821);
    writeFileSync(path.join(root, "platform-router.json"), JSON.stringify(config("legacy-gc", legacyKey)), { mode: 0o640 });
    writeCredential(root, "platform-router.key", "legacy-private-value");
    const orphanKey = keyName(829);
    writeCredential(root, orphanKey, "orphan-private-value");
    writeFileSync(path.join(root, "unknown-operator-file.bin"), "preserve", { mode: 0o640 });
    for (let index = 1; index <= snapshots.length; index += 1) {
      utimesSync(generationPath(root, 830 + index), OLD_TIME, OLD_TIME);
    }
    for (let index = 1; index <= 5; index += 1) {
      utimesSync(path.join(root, keyName(820 + index)), OLD_TIME, OLD_TIME);
    }
    utimesSync(path.join(root, orphanKey), OLD_TIME, OLD_TIME);
    utimesSync(path.join(root, "platform-router.key"), OLD_TIME, OLD_TIME);
    writeFileSync(path.join(root, PLATFORM_ROUTER_POINTER_FILE), pointerWithDraft, { mode: 0o640 });

    const gcHandle = await acquirePlatformRouterLock({ root });
    try {
      const result = garbageCollectPlatformRouterArtifacts(gcHandle, {
        root,
        gcGraceMs: 60_000,
      });
      expect(result.retainedGenerations).toEqual(
        [uuid(834), uuid(835), uuid(836), uuid(837)].sort(),
      );
      expect(result.removedGenerations).toEqual([]);
      expect(result.removedCredentials).toEqual([keyName(822), keyName(823), orphanKey].sort());
      for (let generationNumber = 831; generationNumber <= 837; generationNumber += 1) {
        expect(existsSync(generationPath(root, generationNumber))).toBe(true);
      }
    } finally {
      gcHandle.release();
    }
    for (const preserved of [
      legacyKey,
      keyName(824),
      keyName(825),
      graceKey,
      draftKey,
      "platform-router.key",
      "unknown-operator-file.bin",
    ]) {
      expect(existsSync(path.join(root, preserved))).toBe(true);
    }
  }, 60_000);
});

describe("ported lock-holder and damaged-canonical invariants", () => {
  it("times out against a live owner and recovers the same canonical directory after SIGKILL", async () => {
    const root = caseRoot("ported-child-contention");
    const holderStart = barrier(root, "holder.start");
    const holderResult = barrier(root, "holder.result");
    const holderRelease = barrier(root, "holder.release");
    writeFileSync(holderStart, "go");
    const holder = spawnLockChild(root, holderStart, holderResult, holderRelease, 2_000, true);
    await waitForFile(holderResult, holder);
    expect(readJson(holderResult)).toEqual({ status: "acquired" });
    const canonical = path.join(root, PLATFORM_ROUTER_LOCK_DIRECTORY);
    const inode = statSync(canonical).ino;

    const contenderStart = barrier(root, "contender.start");
    const contenderResult = barrier(root, "contender.result");
    const contenderRelease = barrier(root, "contender.release");
    writeFileSync(contenderStart, "go");
    const contender = spawnLockChild(root, contenderStart, contenderResult, contenderRelease, 180, false);
    await waitForFile(contenderResult, contender);
    await waitForExit(contender);
    expect(readJson(contenderResult)).toEqual({
      status: "timeout",
      errorName: "PlatformRouterLockTimeoutError",
    });

    holder.kill("SIGKILL");
    await waitForExit(holder);
    const recovery = await acquirePlatformRouterLock({ root, timeoutMs: 2_000 });
    expect(statSync(canonical).ino).toBe(inode);
    recovery.release();
    expect(existsSync(canonical)).toBe(false);
  }, 20_000);

  it("does not reinterpret an unrelated ENOENT while checking owner identity as lock release", async () => {
    const root = caseRoot("ported-unrelated-enoent");
    writeStaleLock(root, 900);
    const canonical = path.join(root, PLATFORM_ROUTER_LOCK_DIRECTORY);
    const unrelated = nodeFailure("ENOENT", "boot identity unavailable");
    await expect(
      acquirePlatformRouterLock({
        root,
        timeoutMs: 500,
        readBootId: () => {
          throw unrelated;
        },
      }),
    ).rejects.toBe(unrelated);
    expect(existsSync(canonical)).toBe(true);
    rmSync(canonical, { recursive: true });
  });

  it("detects PID start-ticks reuse without replacing canonical and preserves exact lock modes", async () => {
    const root = caseRoot("ported-pid-reuse");
    writeStaleLock(root, 901);
    const canonical = path.join(root, PLATFORM_ROUTER_LOCK_DIRECTORY);
    const inode = statSync(canonical).ino;
    const handle = await acquirePlatformRouterLock({ root, timeoutMs: 500 });
    expect(statSync(canonical).ino).toBe(inode);
    expect(statSync(canonical).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(canonical, PLATFORM_ROUTER_LOCK_OWNER_FILE)).mode & 0o777).toBe(0o600);
    handle.release();
  });

  it("fails closed during corrupt/missing owner grace, then safely recovers in-place without broad cleanup", async () => {
    for (const [name, ownerBytes] of [
      ["corrupt", "{broken"],
      ["missing", null],
    ] as const) {
      const root = caseRoot(`ported-owner-${name}`);
      const canonical = path.join(root, PLATFORM_ROUTER_LOCK_DIRECTORY);
      mkdirSync(canonical, { mode: 0o700 });
      if (ownerBytes !== null) {
        writeFileSync(path.join(canonical, PLATFORM_ROUTER_LOCK_OWNER_FILE), ownerBytes, { mode: 0o600 });
      }
      const inode = statSync(canonical).ino;
      await expect(
        acquirePlatformRouterLock({ root, timeoutMs: 0, creationGraceMs: 500 }),
      ).rejects.toBeInstanceOf(PlatformRouterLockTimeoutError);
      expect(statSync(canonical).ino).toBe(inode);
      const handle = await acquirePlatformRouterLock({
        root,
        timeoutMs: 500,
        creationGraceMs: 500,
        nowMs: () => Date.now() + 1_000,
      });
      expect(statSync(canonical).ino).toBe(inode);
      expect(JSON.parse(readFileSync(path.join(canonical, PLATFORM_ROUTER_LOCK_OWNER_FILE), "utf8")).nonce).toBe(handle.owner.nonce);
      handle.release();
      expect(readdirSync(root).some((entry) => entry.includes("quarantine"))).toBe(false);
    }
  });
});

async function commitState(
  root: string,
  generationNumber: number,
  parentGenerationId: string | null,
  active: StoredRouterConfig | null,
  pendingAudit: PlatformRouterAuditRecord[] = [],
  extraOptions: Omit<
    PlatformRouterTransactionOptions,
    "root" | "nextId"
  > = {},
): Promise<PlatformRouterSnapshot> {
  const handle = await acquirePlatformRouterLock({ root });
  try {
    return commitGeneration(
      { ...generationInput(generationNumber, parentGenerationId, active), pendingAudit },
      handle,
      { ...transactionOptions(root, generationNumber), ...extraOptions },
    );
  } finally {
    handle.release();
  }
}

async function expectCommitFailureKeeps(
  root: string,
  authoritative: PlatformRouterSnapshot,
  generationNumber: number,
  active: StoredRouterConfig,
  io: PlatformRouterIoOverrides,
): Promise<void> {
  await expect(
    commitState(
      root,
      generationNumber,
      authoritative.generationId,
      active,
      [],
      { io },
    ),
  ).rejects.toThrow();
  expect(readCurrentSnapshot({ root })).toMatchObject({
    generationId: authoritative.generationId,
    active: { model: authoritative.active?.model },
  });
}

function pathAwareIo(callbacks: {
  fsync?: (target: string, descriptor: number) => void;
  rename?: (source: string, destination: string) => void;
}): PlatformRouterIoOverrides {
  const paths = new Map<number, string>();
  return {
    open: ((target, flags, mode) => {
      const descriptor = importOpenSync(target, flags, mode);
      paths.set(descriptor, String(target));
      return descriptor;
    }) as typeof importOpenSync,
    fsync: ((descriptor: number) => {
      const target = paths.get(descriptor) ?? "unknown";
      if (callbacks.fsync) callbacks.fsync(target, descriptor);
      else fsyncSync(descriptor);
    }) as typeof fsyncSync,
    rename: (callbacks.rename ?? renameSync) as typeof renameSync,
  };
}

function generationInput(
  generationNumber: number,
  parentGenerationId: string | null,
  active: StoredRouterConfig | null,
) {
  return {
    generationId: uuid(generationNumber),
    parentGenerationId,
    active,
    draft: null,
    pendingAudit: [] as PlatformRouterAuditRecord[],
  };
}

function transactionOptions(root: string, number: number): PlatformRouterTransactionOptions {
  return { root, nextId: idSequence(number * 10 + 1, number * 10 + 2) };
}

function config(model: string, credentialFile: string): StoredRouterConfig {
  return {
    endpoint: "https://api.example.com/v1",
    model,
    protocol: "openai-compatible",
    enabled: true,
    credentialFile,
  };
}

function auditRecord(number: number, fill = `actor-${number}`): PlatformRouterAuditRecord {
  return {
    eventId: uuid(number),
    at: "2026-08-25T00:00:00.000Z",
    action: "activate",
    actor: fill,
    requestId: fill,
    endpointOrigin: "https://api.example.com",
    model: fill,
    enabled: true,
    keyChanged: true,
  };
}

function staleOwner(number: number) {
  return {
    pid: process.pid,
    bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    startTicks: "0",
    nonce: uuid(number),
    acquiredAt: "2026-08-25T00:00:00.000Z",
  };
}

function writeStaleLock(root: string, number: number): void {
  const lock = path.join(root, PLATFORM_ROUTER_LOCK_DIRECTORY);
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(path.join(lock, PLATFORM_ROUTER_LOCK_OWNER_FILE), `${JSON.stringify(staleOwner(number))}\n`, { mode: 0o600 });
}

function rewriteGenerationAndPointer(
  root: string,
  generationNumber: number,
  isCurrent: boolean,
  mutate: (generation: Record<string, unknown>) => void,
): void {
  const target = generationPath(root, generationNumber);
  const generation = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
  mutate(generation);
  const bytes = Buffer.from(`${JSON.stringify(generation)}\n`);
  writeFileSync(target, bytes, { mode: 0o640 });
  if (isCurrent) {
    writeFileSync(path.join(root, PLATFORM_ROUTER_POINTER_FILE), `${JSON.stringify({ schemaVersion: 1, generationId: uuid(generationNumber), sha256: createHash("sha256").update(bytes).digest("hex") })}\n`, { mode: 0o640 });
  }
}

function generationPath(root: string, number: number): string {
  return path.join(root, PLATFORM_ROUTER_GENERATION_DIRECTORY, `${uuid(number)}.json`);
}

function caseRoot(name: string): string {
  const root = path.join(TEST_ROOT, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o750 });
  return root;
}

function swapCanonicalLock(
  root: string,
  name: string,
  ownerNumber: number,
): SwappedCanonicalLock {
  const canonical = path.join(root, PLATFORM_ROUTER_LOCK_DIRECTORY);
  const original = path.join(root, `parked-${name}-original-lock`);
  const replacement = path.join(root, `parked-${name}-replacement-lock`);
  renameSync(canonical, original);
  mkdirSync(canonical, { mode: 0o700 });
  const replacementOwnerBytes = Buffer.from(
    `${JSON.stringify(staleOwner(ownerNumber))}\n`,
  );
  writeFileSync(
    path.join(canonical, PLATFORM_ROUTER_LOCK_OWNER_FILE),
    replacementOwnerBytes,
    { mode: 0o600 },
  );
  return {
    canonical,
    original,
    replacement,
    replacementInode: statSync(canonical).ino,
    replacementOwnerBytes,
  };
}

function expectCanonicalReplacementUntouched(swap: SwappedCanonicalLock): void {
  expect(statSync(swap.canonical).ino).toBe(swap.replacementInode);
  expect(
    readFileSync(path.join(swap.canonical, PLATFORM_ROUTER_LOCK_OWNER_FILE)),
  ).toEqual(swap.replacementOwnerBytes);
}

function restoreCanonicalLock(
  swap: SwappedCanonicalLock,
  handle: PlatformRouterLockHandle,
): void {
  renameSync(swap.canonical, swap.replacement);
  renameSync(swap.original, swap.canonical);
  handle.release();
  rmSync(swap.replacement, { recursive: true, force: true });
}

function barrier(root: string, name: string): string {
  return path.join(root, name);
}

function idSequence(...numbers: number[]): () => string {
  let index = 0;
  return () => uuid(numbers[index++] ?? numbers[numbers.length - 1] + index);
}

function uuid(number: number): string {
  return `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
}

function keyName(number: number): string {
  return `platform-router-key-${uuid(number)}.key`;
}

function writeCredential(root: string, filename: string, value: string): void {
  const target = path.join(root, filename);
  writeFileSync(target, `${value}\n`, { mode: 0o640 });
  chmodSync(target, 0o640);
}

function legacyHashes(root: string): Record<string, string> {
  return Object.fromEntries(
    [
      "platform-router.json",
      "platform-router.draft.json",
      "platform-router.draft.meta.json",
      "platform-router.draft.test.json",
    ].map((filename) => [
      filename,
      createHash("sha256")
        .update(readFileSync(path.join(root, filename)))
        .digest("hex"),
    ]),
  );
}

function nodeFailure(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function requireOpenSync(
  target: Parameters<typeof import("node:fs").openSync>[0],
  flags: Parameters<typeof import("node:fs").openSync>[1],
  mode?: number,
): number {
  // Kept local so fault-injected open callbacks cannot recurse into themselves.
  return importOpenSync(target, flags, mode);
}

import { openSync as importOpenSync } from "node:fs";

function spawnLockChild(
  root: string,
  start: string,
  result: string,
  release: string,
  timeoutMs: number,
  hold: boolean,
): ChildProcess {
  return spawnTrackedChild([
    CHILD_FIXTURE,
    "lock",
    root,
    start,
    result,
    release,
    String(timeoutMs),
    hold ? "hold" : "release",
  ]);
}

function readJson(target: string): unknown {
  return JSON.parse(readFileSync(target, "utf8"));
}

function spawnTrackedChild(arguments_: string[]): ChildProcess {
  const child = spawn("bun", arguments_, { cwd: WEB_ROOT, stdio: ["ignore", "pipe", "pipe"] });
  const tracked = { stdout: "", stderr: "" };
  trackedChildren.set(child, tracked);
  child.stdout?.on("data", (chunk: Buffer) => { tracked.stdout += chunk.toString("utf8").slice(0, 8_192); });
  child.stderr?.on("data", (chunk: Buffer) => { tracked.stderr += chunk.toString("utf8").slice(0, 8_192); });
  return child;
}

async function waitForFile(target: string, child: ChildProcess, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(target)) {
    if (child.exitCode !== null || child.signalCode !== null) throw childFailure(child);
    if (Date.now() >= deadline) throw new Error(`barrier timeout: ${target}`);
    await delay(10);
  }
}

async function waitForExit(child: ChildProcess, timeoutMs = 8_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child exit timeout")), timeoutMs);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

function childFailure(child: ChildProcess): Error {
  const tracked = trackedChildren.get(child);
  return new Error(`child failed: ${tracked?.stdout ?? ""} ${tracked?.stderr ?? ""}`.trim());
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

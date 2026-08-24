import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
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
  buildPlatformRouterAuditRecord,
  PLATFORM_ROUTER_AUDIT_FILE,
  type PlatformRouterAuditRecord,
} from "./audit";
import { type StoredRouterConfig } from "./contract";
import {
  acquirePlatformRouterLock,
  checkpointDeliveredAudit,
  commitGeneration,
  flushAuditOutbox,
  garbageCollectPlatformRouterArtifacts,
  PLATFORM_ROUTER_GENERATION_DIRECTORY,
  PLATFORM_ROUTER_LOCK_DIRECTORY,
  PLATFORM_ROUTER_LOCK_OWNER_FILE,
  PLATFORM_ROUTER_POINTER_FILE,
  PlatformRouterCommitUncertainError,
  PlatformRouterCorruptionError,
  PlatformRouterLockOwnershipError,
  PlatformRouterLockTimeoutError,
  readCurrentSnapshot,
  recoverPlatformRouterTransactions,
  type PlatformRouterIoOverrides,
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
const CHILD_OUTPUT_LIMIT = 8 * 1024;
const trackedChildren = new Map<ChildProcess, TrackedChild>();

interface TrackedChild {
  stdout: string;
  stderr: string;
  spawnError: Error | null;
}

beforeAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true, mode: 0o750 });
});

afterEach(async () => {
  await cleanupTrackedChildren();
});

afterAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("cross-process platform router transaction lock", () => {
  it("times out against a live Bun owner and recovers immediately after SIGKILL", async () => {
    const root = caseRoot("child-contention");
    const holderStart = barrier(root, "holder.start");
    const holderResult = barrier(root, "holder.result");
    const holderRelease = barrier(root, "holder.release");
    const contenderStart = barrier(root, "contender.start");
    const contenderResult = barrier(root, "contender.result");
    const contenderRelease = barrier(root, "contender.release");
    writeFileSync(holderStart, "go");
    const holder = spawnLockChild(
      root,
      holderStart,
      holderResult,
      holderRelease,
      2_000,
      true,
    );
    await waitForFile(holderResult, holder);
    expect(readJson(holderResult)).toEqual({ status: "acquired" });

    writeFileSync(contenderStart, "go");
    const contender = spawnLockChild(
      root,
      contenderStart,
      contenderResult,
      contenderRelease,
      180,
      false,
    );
    await waitForFile(contenderResult, contender);
    await waitForExit(contender);
    expect(readJson(contenderResult)).toEqual({
      status: "timeout",
      errorName: "PlatformRouterLockTimeoutError",
    });

    holder.kill("SIGKILL");
    await waitForExit(holder);
    const recoveryStart = barrier(root, "recovery.start");
    const recoveryResult = barrier(root, "recovery.result");
    const recoveryRelease = barrier(root, "recovery.release");
    writeFileSync(recoveryStart, "go");
    const recovery = spawnLockChild(
      root,
      recoveryStart,
      recoveryResult,
      recoveryRelease,
      2_000,
      false,
    );
    await waitForFile(recoveryResult, recovery);
    await waitForExit(recovery);
    expect(readJson(recoveryResult)).toEqual({ status: "acquired" });
    expect(existsSync(path.join(root, PLATFORM_ROUTER_LOCK_DIRECTORY))).toBe(
      false,
    );
    expect(
      readdirSync(root).some((entry) => entry.includes(".quarantine-")),
    ).toBe(false);
  }, 20_000);

  it("retries when the holder disappears between EEXIST and lock inspection", async () => {
    const root = caseRoot("release-before-inspection");
    const lock = path.join(root, PLATFORM_ROUTER_LOCK_DIRECTORY);
    mkdirSync(lock, { mode: 0o700 });
    let releasedDuringRace = false;
    const raceLstat = ((target: string) => {
      if (target === lock && !releasedDuringRace) {
        releasedDuringRace = true;
        rmSync(lock, { recursive: true, force: true });
        throw nodeFailure("ENOENT", "holder released before inspection");
      }
      return lstatSync(target);
    }) as typeof lstatSync;

    const handle = await acquirePlatformRouterLock({
      root,
      timeoutMs: 500,
      io: { lstat: raceLstat },
      nextId: idSequence(190),
    });

    expect(releasedDuringRace).toBe(true);
    expect(handle.owner.nonce).toBe(uuid(190));
    handle.release();
    expect(existsSync(lock)).toBe(false);
  });

  it("does not reinterpret unrelated ENOENT failures as a released lock", async () => {
    const root = caseRoot("non-lock-enoent");
    const lock = path.join(root, PLATFORM_ROUTER_LOCK_DIRECTORY);
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(
      path.join(lock, PLATFORM_ROUTER_LOCK_OWNER_FILE),
      JSON.stringify({
        pid: process.pid,
        bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
        startTicks: "0",
        nonce: uuid(191),
        acquiredAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    const unrelatedMissing = nodeFailure("ENOENT", "boot identity unavailable");

    await expect(
      acquirePlatformRouterLock({
        root,
        timeoutMs: 500,
        readBootId: () => {
          throw unrelatedMissing;
        },
      }),
    ).rejects.toBe(unrelatedMissing);
    expect(existsSync(lock)).toBe(true);
    rmSync(lock, { recursive: true, force: true });
  });

  it("treats a PID start-ticks mismatch as stale immediately and quarantines safely", async () => {
    const root = caseRoot("pid-reuse");
    const lock = path.join(root, PLATFORM_ROUTER_LOCK_DIRECTORY);
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(
      path.join(lock, PLATFORM_ROUTER_LOCK_OWNER_FILE),
      JSON.stringify({
        pid: process.pid,
        bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
        startTicks: "0",
        nonce: uuid(201),
        acquiredAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    const handle = await acquirePlatformRouterLock({
      root,
      timeoutMs: 500,
      nextId: idSequence(202, 203),
    });
    expect(handle.owner.nonce).toBe(uuid(203));
    expect(statSync(lock).mode & 0o777).toBe(0o700);
    expect(
      statSync(path.join(lock, PLATFORM_ROUTER_LOCK_OWNER_FILE)).mode & 0o777,
    ).toBe(0o600);
    handle.release();
    expect(readdirSync(root)).not.toContain(
      `${PLATFORM_ROUTER_LOCK_DIRECTORY}.quarantine-${uuid(202)}`,
    );
  });

  it("honors malformed-owner creation grace and release never removes a new nonce", async () => {
    const root = caseRoot("owner-grace");
    const lock = path.join(root, PLATFORM_ROUTER_LOCK_DIRECTORY);
    mkdirSync(lock, { mode: 0o700 });
    writeFileSync(path.join(lock, PLATFORM_ROUTER_LOCK_OWNER_FILE), "{broken", {
      mode: 0o600,
    });
    await expect(
      acquirePlatformRouterLock({ root, timeoutMs: 0, creationGraceMs: 500 }),
    ).rejects.toBeInstanceOf(PlatformRouterLockTimeoutError);
    expect(existsSync(lock)).toBe(true);

    const handle = await acquirePlatformRouterLock({
      root,
      timeoutMs: 500,
      creationGraceMs: 500,
      nowMs: () => Date.now() + 1_000,
      nextId: idSequence(204, 205),
    });
    writeFileSync(
      path.join(lock, PLATFORM_ROUTER_LOCK_OWNER_FILE),
      JSON.stringify({ ...handle.owner, nonce: uuid(206) }),
      { mode: 0o600 },
    );
    expect(() => handle.release()).toThrow(PlatformRouterLockOwnershipError);
    expect(existsSync(lock)).toBe(true);
    rmSync(lock, { recursive: true, force: true });
  });
});

describe("immutable generation and atomic pointer", () => {
  it("commits, verifies checksum, fails closed on corruption/symlinks, and falls back only when absent", () => {
    const root = caseRoot("generation-read");
    const key = keyName(301);
    writeCredential(root, key, SENTINEL);
    const snapshot = commitState(root, 311, null, config("model-one", key));
    expect(snapshot.source).toBe("generation");
    expect(readCurrentSnapshot({ root }).active?.model).toBe("model-one");
    expect(
      statSync(path.join(root, PLATFORM_ROUTER_GENERATION_DIRECTORY)).mode &
        0o777,
    ).toBe(0o750);
    expect(
      statSync(
        path.join(
          root,
          PLATFORM_ROUTER_GENERATION_DIRECTORY,
          `${uuid(311)}.json`,
        ),
      ).mode & 0o777,
    ).toBe(0o640);
    expect(statSync(path.join(root, PLATFORM_ROUTER_POINTER_FILE)).mode & 0o777).toBe(
      0o640,
    );

    const generationPath = path.join(
      root,
      PLATFORM_ROUTER_GENERATION_DIRECTORY,
      `${uuid(311)}.json`,
    );
    const originalGeneration = readFileSync(generationPath);
    writeFileSync(generationPath, Buffer.concat([originalGeneration, Buffer.from(" ")]));
    expect(() => readCurrentSnapshot({ root })).toThrow(
      PlatformRouterCorruptionError,
    );
    writeFileSync(generationPath, originalGeneration);
    const outsideGeneration = path.join(TEST_ROOT, "outside-generation");
    writeFileSync(outsideGeneration, originalGeneration);
    unlinkSync(generationPath);
    symlinkSync(outsideGeneration, generationPath);
    expect(() => readCurrentSnapshot({ root })).toThrow(
      PlatformRouterCorruptionError,
    );
    unlinkSync(generationPath);
    writeFileSync(generationPath, originalGeneration, { mode: 0o640 });

    const pointerPath = path.join(root, PLATFORM_ROUTER_POINTER_FILE);
    const originalPointer = readFileSync(pointerPath);
    writeFileSync(pointerPath, "{broken\n");
    expect(() => readCurrentSnapshot({ root })).toThrow(
      PlatformRouterCorruptionError,
    );
    writeFileSync(pointerPath, originalPointer);

    unlinkSync(pointerPath);
    writeFileSync(
      path.join(root, "platform-router.json"),
      JSON.stringify(config("legacy-model", key)),
      { mode: 0o640 },
    );
    expect(readCurrentSnapshot({ root })).toMatchObject({
      source: "legacy",
      active: { model: "legacy-model" },
    });

    const outside = path.join(TEST_ROOT, "outside-pointer");
    writeFileSync(outside, originalPointer);
    symlinkSync(outside, pointerPath);
    expect(() => readCurrentSnapshot({ root })).toThrow(
      PlatformRouterCorruptionError,
    );
  });

  it("loops short writes and preserves the exact old/committed state at every crash boundary", () => {
    const root = caseRoot("crash-boundaries");
    const oldKey = keyName(320);
    const newKey = keyName(321);
    writeCredential(root, oldKey, "old-private-value");
    writeCredential(root, newKey, SENTINEL);
    const old = commitState(root, 322, null, config("old-model", oldKey));

    let shortWriteCalls = 0;
    const shortWrite = ((
      descriptor: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      shortWriteCalls += 1;
      return writeSync(
        descriptor,
        buffer,
        offset,
        Math.min(7, length),
        position,
      );
    }) as typeof writeSync;
    const short = commitState(
      root,
      323,
      old.generationId,
      config("short-write-model", newKey),
      [],
      { io: { write: shortWrite } },
    );
    expect(shortWriteCalls).toBeGreaterThan(10);
    expect(readCurrentSnapshot({ root }).generationId).toBe(short.generationId);

    const authoritative = short;
    expectCommitFailureKeeps(
      root,
      authoritative,
      324,
      config("zero-write-model", newKey),
      {
        write: (() => 0) as typeof writeSync,
      },
    );

    const generationFsync = pathAwareIo({
      fsync(target, descriptor) {
        if (
          target.includes(PLATFORM_ROUTER_GENERATION_DIRECTORY) &&
          target.endsWith(".tmp")
        ) {
          throw nodeFailure("ENOSPC", "generation fsync full");
        }
        fsyncSync(descriptor);
      },
    });
    expectCommitFailureKeeps(
      root,
      authoritative,
      325,
      config("generation-fsync-model", newKey),
      generationFsync,
    );

    const pointerDenied: PlatformRouterIoOverrides = {
      rename: ((source: string, destination: string) => {
        if (destination.endsWith(PLATFORM_ROUTER_POINTER_FILE)) {
          throw nodeFailure("EACCES", "pointer rename denied");
        }
        renameSync(source, destination);
      }) as typeof renameSync,
    };
    expectCommitFailureKeeps(
      root,
      authoritative,
      326,
      config("orphan-model", newKey),
      pointerDenied,
    );
    expect(
      existsSync(
        path.join(
          root,
          PLATFORM_ROUTER_GENERATION_DIRECTORY,
          `${uuid(326)}.json`,
        ),
      ),
    ).toBe(true);

    let pointerRenamed = false;
    const uncertainIo = pathAwareIo({
      rename(source, destination) {
        renameSync(source, destination);
        if (destination.endsWith(PLATFORM_ROUTER_POINTER_FILE)) {
          pointerRenamed = true;
        }
      },
      fsync(target, descriptor) {
        if (pointerRenamed && target === root) {
          throw nodeFailure("ENOSPC", "root directory fsync full");
        }
        fsyncSync(descriptor);
      },
    });
    expect(() =>
      commitState(
        root,
        327,
        authoritative.generationId,
        config("committed-uncertain-model", newKey),
        [],
        { io: uncertainIo },
      ),
    ).toThrow(PlatformRouterCommitUncertainError);
    expect(readCurrentSnapshot({ root })).toMatchObject({
      generationId: uuid(327),
      active: { model: "committed-uncertain-model" },
    });
    expect(() =>
      commitState(
        root,
        327,
        authoritative.generationId,
        config("must-not-overwrite", newKey),
      ),
    ).toThrow("代际已存在");
    expect(readCurrentSnapshot({ root })).toMatchObject({
      generationId: uuid(327),
      active: { model: "committed-uncertain-model" },
    });
  });

  it("lets a real lock-free reader observe only whole checksummed snapshots during pointer races", async () => {
    const root = caseRoot("reader-race");
    const key = keyName(340);
    writeCredential(root, key, SENTINEL);
    let current = commitState(root, 341, null, config("race-model-0", key));
    const start = barrier(root, "reader.start");
    const stop = barrier(root, "reader.stop");
    const result = barrier(root, "reader.result");
    const reader = spawnTrackedChild([
      CHILD_FIXTURE,
      "race-read",
      root,
      start,
      stop,
      result,
    ]);
    writeFileSync(start, "go");
    for (let index = 1; index <= 12; index += 1) {
      current = commitState(
        root,
        341 + index,
        current.generationId,
        config(`race-model-${index}`, key),
      );
      await delay(2);
    }
    writeFileSync(stop, "stop");
    await waitForFile(result, reader);
    await waitForExit(reader);
    const observed = readJson(result) as { models: string[]; errors: string[] };
    expect(observed.errors).toEqual([]);
    expect(observed.models.every((model) => /^race-model-\d+$/.test(model))).toBe(
      true,
    );
  }, 20_000);
});

describe("durable audit projection and checkpoint", () => {
  it("repairs a partial append, replays by eventId once, and rejects complete malformed lines", () => {
    const root = caseRoot("audit-replay");
    const event = auditRecord(401);
    const snapshot = commitState(root, 402, null, null, [event]);
    let writeCalls = 0;
    const partialWriter = ((
      descriptor: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      writeCalls += 1;
      if (writeCalls > 1) throw nodeFailure("ENOSPC", "audit device full");
      return writeSync(
        descriptor,
        buffer,
        offset,
        Math.min(17, length),
        position,
      );
    }) as typeof writeSync;
    expect(() =>
      flushAuditOutbox(snapshot, { root, io: { write: partialWriter } }),
    ).toThrow("审计投影失败");
    expect(readCurrentSnapshot({ root }).pendingAudit).toHaveLength(1);

    const replay = flushAuditOutbox(snapshot, { root });
    expect(replay.repairedTail).toBe(true);
    expect(replay.appendedEventIds).toEqual([event.eventId]);
    const duplicateReplay = flushAuditOutbox(snapshot, { root });
    expect(duplicateReplay.appendedEventIds).toEqual([]);
    const lines = readFileSync(
      path.join(root, PLATFORM_ROUTER_AUDIT_FILE),
      "utf8",
    )
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).eventId).toBe(event.eventId);

    const checkpoint = checkpointDeliveredAudit(
      snapshot,
      replay.deliveredEventIds,
      transactionOptions(root, 403),
    );
    expect(checkpoint.pendingAudit).toEqual([]);

    const malformedRoot = caseRoot("audit-malformed");
    const malformedSnapshot = commitState(
      malformedRoot,
      404,
      null,
      null,
      [event],
    );
    writeFileSync(
      path.join(malformedRoot, PLATFORM_ROUTER_AUDIT_FILE),
      "{complete-but-invalid}\n",
      { mode: 0o640 },
    );
    expect(() => flushAuditOutbox(malformedSnapshot, { root: malformedRoot })).toThrow(
      "完整的无效记录",
    );
  });

  it("streams a valid journal larger than 1 MiB and retains only wanted eventIds for dedupe", () => {
    const root = caseRoot("audit-large-stream");
    const existing = auditRecord(420);
    const missing = auditRecord(421);
    const snapshot = commitState(root, 422, null, null, [existing, missing]);
    const historicalLines = Array.from({ length: 5_000 }, (_, index) =>
      JSON.stringify(auditRecord(10_000 + index)),
    );
    const auditPath = path.join(root, PLATFORM_ROUTER_AUDIT_FILE);
    const initialJournal = `${historicalLines.join("\n")}\n${JSON.stringify(existing)}\n`;
    expect(Buffer.byteLength(initialJournal)).toBeGreaterThan(1024 * 1024);
    writeFileSync(auditPath, initialJournal, { mode: 0o640 });

    const replay = flushAuditOutbox(snapshot, { root });

    expect(replay.repairedTail).toBe(false);
    expect(replay.appendedEventIds).toEqual([missing.eventId]);
    const matchingEventIds = readFileSync(auditPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).eventId)
      .filter(
        (eventId) => eventId === existing.eventId || eventId === missing.eventId,
      );
    expect(matchingEventIds).toEqual([existing.eventId, missing.eventId]);
    const checkpoint = checkpointDeliveredAudit(
      snapshot,
      replay.deliveredEventIds,
      transactionOptions(root, 423),
    );
    expect(checkpoint.pendingAudit).toEqual([]);
  });

  it("rejects an oversized single audit record without truncating history", () => {
    const root = caseRoot("audit-oversized-record");
    const event = auditRecord(430);
    const snapshot = commitState(root, 431, null, null, [event]);
    const oversized = `${JSON.stringify({
      ...auditRecord(432),
      padding: "x".repeat(70 * 1024),
    })}\n`;
    const auditPath = path.join(root, PLATFORM_ROUTER_AUDIT_FILE);
    writeFileSync(auditPath, oversized, { mode: 0o640 });

    expect(() => flushAuditOutbox(snapshot, { root })).toThrow(
      "单条记录过大",
    );
    expect(readFileSync(auditPath, "utf8")).toBe(oversized);
  });

  it("dedupes journal-fsynced events when checkpoint commit fails, then checkpoints on replay", () => {
    const root = caseRoot("checkpoint-failure");
    const event = auditRecord(410);
    const snapshot = commitState(root, 411, null, null, [event]);
    const flushed = flushAuditOutbox(snapshot, { root });
    const pointerDenied: PlatformRouterIoOverrides = {
      rename: ((source: string, destination: string) => {
        if (destination.endsWith(PLATFORM_ROUTER_POINTER_FILE)) {
          throw nodeFailure("EACCES", "checkpoint pointer denied");
        }
        renameSync(source, destination);
      }) as typeof renameSync,
    };
    expect(() =>
      checkpointDeliveredAudit(snapshot, flushed.deliveredEventIds, {
        ...transactionOptions(root, 412),
        io: pointerDenied,
      }),
    ).toThrow("代际提交失败");
    expect(readCurrentSnapshot({ root }).pendingAudit).toHaveLength(1);

    const replay = flushAuditOutbox(readCurrentSnapshot({ root }), { root });
    expect(replay.appendedEventIds).toEqual([]);
    const checkpoint = checkpointDeliveredAudit(
      readCurrentSnapshot({ root }),
      replay.deliveredEventIds,
      transactionOptions(root, 413),
    );
    expect(checkpoint.pendingAudit).toEqual([]);
    expect(
      readFileSync(path.join(root, PLATFORM_ROUTER_AUDIT_FILE), "utf8")
        .trim()
        .split("\n"),
    ).toHaveLength(1);
  });
});

describe("recovery, legacy import, and garbage collection", () => {
  it("imports legacy state without modifying it, validates credentials, and never serializes secrets", async () => {
    const root = caseRoot("legacy-recovery");
    const key = keyName(501);
    const activeRaw = `${JSON.stringify(config("legacy-active", key))}\n`;
    const draftRaw = `${JSON.stringify(config("legacy-draft", key))}\n`;
    writeFileSync(path.join(root, "platform-router.json"), activeRaw, {
      mode: 0o640,
    });
    writeFileSync(path.join(root, "platform-router.draft.json"), draftRaw, {
      mode: 0o640,
    });
    writeFileSync(
      path.join(root, "platform-router.draft.meta.json"),
      '{"keyChanged":true}\n',
      { mode: 0o640 },
    );
    writeFileSync(
      path.join(root, "platform-router.draft.test.json"),
      `${JSON.stringify({
        digest: "a".repeat(64),
        testedAt: "2026-08-25T00:00:00.000Z",
        requestId: "legacy-request",
      })}\n`,
      { mode: 0o640 },
    );
    writeCredential(root, key, SENTINEL);
    const hashesBefore = legacyHashes(root);
    const generationDirectory = path.join(
      root,
      PLATFORM_ROUTER_GENERATION_DIRECTORY,
    );
    mkdirSync(generationDirectory, { mode: 0o750 });
    const generationTemp = `.${uuid(502)}.${uuid(503)}.tmp`;
    const pointerTemp = `.platform-router.current.${uuid(504)}.tmp`;
    writeFileSync(path.join(generationDirectory, generationTemp), "orphan", {
      mode: 0o640,
    });
    writeFileSync(path.join(root, pointerTemp), "orphan", { mode: 0o640 });
    writeFileSync(path.join(root, "operator-note.keep"), "keep", {
      mode: 0o640,
    });

    const result = await recoverPlatformRouterTransactions({ root });

    expect(result.importedLegacy).toBe(true);
    expect(result.snapshot).toMatchObject({
      source: "generation",
      active: { model: "legacy-active" },
      draft: { config: { model: "legacy-draft" } },
    });
    expect(legacyHashes(root)).toEqual(hashesBefore);
    expect(existsSync(path.join(generationDirectory, generationTemp))).toBe(false);
    expect(existsSync(path.join(root, pointerTemp))).toBe(false);
    expect(existsSync(path.join(root, "operator-note.keep"))).toBe(true);
    const publicArtifacts = [
      PLATFORM_ROUTER_POINTER_FILE,
      PLATFORM_ROUTER_AUDIT_FILE,
      ...readdirSync(path.join(root, PLATFORM_ROUTER_GENERATION_DIRECTORY)),
    ];
    for (const artifact of publicArtifacts) {
      const target = artifact.endsWith(".json")
        ? path.join(root, PLATFORM_ROUTER_GENERATION_DIRECTORY, artifact)
        : path.join(root, artifact);
      if (existsSync(target)) {
        expect(readFileSync(target, "utf8")).not.toContain(SENTINEL);
      }
    }
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(
      createHash("sha256").update(readFileSync(path.join(root, key))).digest("hex"),
    ).toHaveLength(64);
  });

  it("fails recovery closed when a referenced credential is a symlink", async () => {
    const root = caseRoot("legacy-symlink-key");
    const key = keyName(510);
    writeFileSync(
      path.join(root, "platform-router.json"),
      JSON.stringify(config("legacy-active", key)),
      { mode: 0o640 },
    );
    const outside = path.join(TEST_ROOT, "outside-key");
    writeCredential(TEST_ROOT, path.basename(outside), SENTINEL);
    symlinkSync(outside, path.join(root, key));
    await expect(recoverPlatformRouterTransactions({ root })).rejects.toThrow(
      PlatformRouterCorruptionError,
    );
    expect(existsSync(path.join(root, PLATFORM_ROUTER_POINTER_FILE))).toBe(false);
  });

  it("keeps current plus two predecessors, grace generations, and every referenced or legacy key", () => {
    const root = caseRoot("gc");
    const snapshots: PlatformRouterSnapshot[] = [];
    let parent: string | null = null;
    for (let index = 1; index <= 5; index += 1) {
      const key = keyName(520 + index);
      writeCredential(root, key, `private-value-${index}`);
      const snapshot = commitState(
        root,
        530 + index,
        parent,
        config(`gc-model-${index}`, key),
      );
      snapshots.push(snapshot);
      parent = snapshot.generationId;
    }
    const currentPointer = readFileSync(
      path.join(root, PLATFORM_ROUTER_POINTER_FILE),
    );
    const graceKey = keyName(526);
    writeCredential(root, graceKey, "grace-private-value");
    commitState(root, 536, parent, config("grace-orphan", graceKey));
    writeFileSync(path.join(root, PLATFORM_ROUTER_POINTER_FILE), currentPointer);

    const legacyKey = keyName(521);
    writeFileSync(
      path.join(root, "platform-router.json"),
      JSON.stringify(config("legacy-gc", legacyKey)),
      { mode: 0o640 },
    );
    writeCredential(root, "platform-router.key", "legacy-private-value");
    const orphanKey = keyName(529);
    writeCredential(root, orphanKey, "orphan-private-value");
    writeFileSync(path.join(root, "unknown-operator-file.bin"), "preserve", {
      mode: 0o640,
    });
    for (const snapshot of snapshots) {
      const generationPath = path.join(
        root,
        PLATFORM_ROUTER_GENERATION_DIRECTORY,
        `${snapshot.generationId}.json`,
      );
      utimesSync(generationPath, OLD_TIME, OLD_TIME);
    }
    for (let index = 1; index <= 5; index += 1) {
      utimesSync(path.join(root, keyName(520 + index)), OLD_TIME, OLD_TIME);
    }
    utimesSync(path.join(root, orphanKey), OLD_TIME, OLD_TIME);
    utimesSync(path.join(root, "platform-router.key"), OLD_TIME, OLD_TIME);

    const result = garbageCollectPlatformRouterArtifacts({
      root,
      gcGraceMs: 1_000,
    });

    expect(result.retainedGenerations).toEqual(
      [uuid(533), uuid(534), uuid(535), uuid(536)].sort(),
    );
    expect(result.removedGenerations).toEqual([uuid(531), uuid(532)]);
    expect(result.removedCredentials).toEqual(
      [keyName(522), orphanKey].sort(),
    );
    expect(existsSync(path.join(root, legacyKey))).toBe(true);
    expect(existsSync(path.join(root, keyName(523)))).toBe(true);
    expect(existsSync(path.join(root, keyName(524)))).toBe(true);
    expect(existsSync(path.join(root, keyName(525)))).toBe(true);
    expect(existsSync(path.join(root, graceKey))).toBe(true);
    expect(existsSync(path.join(root, "platform-router.key"))).toBe(true);
    expect(existsSync(path.join(root, "unknown-operator-file.bin"))).toBe(true);
  });
});

function commitState(
  root: string,
  generationNumber: number,
  parentGenerationId: string | null,
  active: StoredRouterConfig | null,
  pendingAudit: PlatformRouterAuditRecord[] = [],
  extraOptions: Omit<PlatformRouterTransactionOptions, "root" | "nextId"> = {},
): PlatformRouterSnapshot {
  return commitGeneration(
    {
      generationId: uuid(generationNumber),
      parentGenerationId,
      active,
      draft: null,
      pendingAudit,
    },
    {
      root,
      nextId: idSequence(generationNumber * 10 + 1, generationNumber * 10 + 2),
      ...extraOptions,
    },
  );
}

function expectCommitFailureKeeps(
  root: string,
  authoritative: PlatformRouterSnapshot,
  generationNumber: number,
  active: StoredRouterConfig,
  io: PlatformRouterIoOverrides,
): void {
  expect(() =>
    commitState(
      root,
      generationNumber,
      authoritative.generationId,
      active,
      [],
      { io },
    ),
  ).toThrow();
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
    open: ((target: string, flags: number, mode?: number) => {
      const descriptor = openSync(target, flags, mode);
      paths.set(descriptor, target);
      return descriptor;
    }) as typeof openSync,
    fsync: ((descriptor: number) => {
      const target = paths.get(descriptor) ?? "unknown";
      if (callbacks.fsync) callbacks.fsync(target, descriptor);
      else fsyncSync(descriptor);
    }) as typeof fsyncSync,
    rename: (callbacks.rename ?? renameSync) as typeof renameSync,
  };
}

function config(model: string, credentialFile: string): StoredRouterConfig {
  return {
    endpoint: "https://api.lmm.best/v1",
    model,
    protocol: "openai-compatible",
    enabled: true,
    credentialFile,
  };
}

function auditRecord(number: number): PlatformRouterAuditRecord {
  return buildPlatformRouterAuditRecord(
    {
      eventId: uuid(number),
      action: "activate",
      actor: "root-super-admin-id",
      requestId: `request-${number}`,
      endpoint: "https://api.lmm.best/v1",
      model: "gpt-5.6-sol",
      enabled: true,
      keyChanged: true,
    },
    new Date("2026-08-25T00:00:00.000Z"),
  );
}

function transactionOptions(
  root: string,
  firstTemporaryId: number,
): PlatformRouterTransactionOptions {
  return {
    root,
    nextId: idSequence(firstTemporaryId, firstTemporaryId + 1, firstTemporaryId + 2),
  };
}

function idSequence(...numbers: number[]): () => string {
  const values = numbers.map(uuid);
  return () => {
    const value = values.shift();
    if (!value) throw new Error("test ID sequence exhausted");
    return value;
  };
}

function uuid(number: number): string {
  return `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;
}

function keyName(number: number): string {
  return `platform-router-key-${uuid(number)}.key`;
}

function writeCredential(root: string, filename: string, value: string): void {
  writeFileSync(path.join(root, filename), `${value}\n`, { mode: 0o640 });
  chmodSync(path.join(root, filename), 0o640);
}

function caseRoot(name: string): string {
  const root = path.join(TEST_ROOT, name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true, mode: 0o750 });
  return root;
}

function barrier(root: string, name: string): string {
  return path.join(root, name);
}

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

function spawnTrackedChild(arguments_: string[]): ChildProcess {
  const child = spawn("bun", arguments_, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tracked: TrackedChild = { stdout: "", stderr: "", spawnError: null };
  trackedChildren.set(child, tracked);
  child.stdout?.on("data", (chunk: Buffer) => {
    tracked.stdout = appendBoundedOutput(tracked.stdout, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    tracked.stderr = appendBoundedOutput(tracked.stderr, chunk);
  });
  child.once("error", (cause) => {
    tracked.spawnError = cause;
  });
  return child;
}

async function waitForFile(
  target: string,
  child: ChildProcess,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(target)) {
    const tracked = trackedChildren.get(child);
    if (
      tracked?.spawnError ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      throw childFailure("child exited before result barrier", child);
    }
    if (Date.now() >= deadline) {
      throw childFailure("child result barrier timed out", child);
    }
    await delay(10);
  }
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs = 8_000,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      removeListeners();
      reject(childFailure("child exit timed out", child));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      removeListeners();
      resolve();
    };
    const onError = () => {
      clearTimeout(timer);
      removeListeners();
      reject(childFailure("child process failed", child));
    };
    const removeListeners = () => {
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function cleanupTrackedChildren(): Promise<void> {
  const children = [...trackedChildren.keys()];
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  const failures: Error[] = [];
  for (const child of children) {
    try {
      await waitForExit(child, 3_000);
    } catch (cause) {
      failures.push(cause instanceof Error ? cause : new Error(String(cause)));
    }
  }
  trackedChildren.clear();
  if (failures.length > 0) throw new AggregateError(failures, "child cleanup failed");
}

function appendBoundedOutput(current: string, chunk: Buffer): string {
  return `${current}${chunk.toString("utf8")}`.slice(-CHILD_OUTPUT_LIMIT);
}

function childFailure(message: string, child: ChildProcess): Error {
  const tracked = trackedChildren.get(child);
  const status = `exit=${child.exitCode ?? "running"} signal=${child.signalCode ?? "none"}`;
  const stdout = sanitizeChildOutput(tracked?.stdout ?? "");
  const stderr = sanitizeChildOutput(tracked?.stderr ?? "");
  const spawnError = tracked?.spawnError
    ? sanitizeChildOutput(
        `${tracked.spawnError.name}: ${tracked.spawnError.message}`,
      )
    : "none";
  return new Error(
    `${message}; ${status}; spawnError=${JSON.stringify(spawnError)}; stdout=${JSON.stringify(stdout)}; stderr=${JSON.stringify(stderr)}`,
  );
}

function sanitizeChildOutput(value: string): string {
  return value
    .replaceAll(SENTINEL, "[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "[redacted]")
    .replace(/(api[_-]?key\s*[=:]\s*)\S+/gi, "$1[redacted]");
}

function readJson(target: string): unknown {
  return JSON.parse(readFileSync(target, "utf8"));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function nodeFailure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
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

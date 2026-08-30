import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PLATFORM_ROUTER_AUDIT_FILE } from "./audit";
import type { ManagedPlatformRouterInput } from "./contract";
import { createProtectedPlatformRouterStorage } from "./protected-storage";
import {
  createTransactionalManagedPlatformRouterLifecycle,
  PlatformRouterStateIndeterminateError,
  PlatformRouterStorageUncertainError,
} from "./transactional-lifecycle";
import {
  acquirePlatformRouterLock,
  PLATFORM_ROUTER_GENERATION_DIRECTORY,
  PLATFORM_ROUTER_LOCK_DIRECTORY,
  PLATFORM_ROUTER_POINTER_FILE,
  PlatformRouterAuditPendingError,
  PlatformRouterConflictError,
  PlatformRouterCorruptionError,
  PlatformRouterLockOwnershipError,
  PlatformRouterLockTimeoutError,
  readCurrentSnapshot,
  recoverPlatformRouterTransactions,
  type PlatformRouterIoOverrides,
} from "./transaction";

const WEB_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const TEST_ROOT = path.join(WEB_ROOT, ".scratch", "transaction-b2a-tests");
const CHILD_FIXTURE = path.join(
  WEB_ROOT,
  "src/lib/platform-router-config/fixtures/transaction-child.ts",
);
const SENTINEL = "SENTINEL_B2A_PRIVATE_KEY_DO_NOT_LEAK";
const children = new Set<ChildProcess>();

beforeAll(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true, mode: 0o750 });
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await waitForExit(child).catch(() => undefined);
  }
  children.clear();
});

afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

function input(
  model: string,
  apiKey?: string,
): ManagedPlatformRouterInput {
  return {
    endpoint: "https://api.lmm.best/v1",
    model,
    protocol: "openai-compatible",
    enabled: true,
    apiKey,
  };
}

function fixture(name: string, io?: PlatformRouterIoOverrides) {
  const root = caseRoot(name);
  const storage = createProtectedPlatformRouterStorage(root);
  const lifecycle = createTransactionalManagedPlatformRouterLifecycle({
    storage,
    transactionOptions: { root, timeoutMs: 2_000, io },
  });
  return { root, storage, lifecycle };
}

describe("transactional managed platform router lifecycle", () => {
  it("stages, attests, and activates without exposing or materializing secrets", async () => {
    const { root, lifecycle } = fixture("happy-path");
    const staged = await lifecycle.stage(input("draft-model", SENTINEL), {
      actor: "admin@example.com",
      requestId: "stage-1",
    });

    expect(staged).toMatchObject({
      committed: true,
      auditPending: false,
      value: { model: "draft-model", testedReady: false, keyChanged: true },
      state: {
        config: null,
        draft: { model: "draft-model", testedReady: false, keyChanged: true },
      },
    });
    expect(JSON.stringify(staged)).not.toContain(SENTINEL);
    const prepared = lifecycle.prepareDraftProbe();
    expect(prepared.secret.apiKey).toBe(SENTINEL);
    expect(prepared.draft).not.toHaveProperty("apiKey");

    const tested = await lifecycle.markTested({
      actor: "admin@example.com",
      requestId: "probe-ready",
      expectedGenerationId: prepared.expectedGenerationId,
      expectedDraftDigest: prepared.expectedDraftDigest,
      status: "ready",
    });
    expect(tested.value.testedReady).toBe(true);

    const activated = await lifecycle.activate({
      actor: "admin@example.com",
      requestId: "activate-1",
    });
    expect(activated).toMatchObject({
      value: {
        model: "draft-model",
        credentialConfigured: true,
      },
      state: {
        config: { model: "draft-model", credentialConfigured: true },
        draft: null,
      },
    });
    expect(lifecycle.readActive()).toMatchObject({
      model: "draft-model",
      apiKey: SENTINEL,
    });
    expect(lifecycle.getDraft()).toBeNull();

    const publicArtifacts = [
      path.join(root, PLATFORM_ROUTER_POINTER_FILE),
      path.join(root, PLATFORM_ROUTER_AUDIT_FILE),
      ...readdirSync(path.join(root, PLATFORM_ROUTER_GENERATION_DIRECTORY)).map(
        (entry) => path.join(root, PLATFORM_ROUTER_GENERATION_DIRECTORY, entry),
      ),
    ];
    for (const artifact of publicArtifacts) {
      expect(readFileSync(artifact, "utf8")).not.toContain(SENTINEL);
    }
    expect(existsSync(path.join(root, "platform-router.json"))).toBe(false);
    expect(existsSync(path.join(root, "platform-router.draft.json"))).toBe(false);
  });

  it("keeps each mutation result pinned to its committed generation after a later writer wins", async () => {
    const { lifecycle } = fixture("committed-result-snapshot");
    const first = await lifecycle.stage(input("first", "first-key"), {
      actor: "first-admin",
      requestId: "first-stage",
    });
    const second = await lifecycle.stage(input("second", "second-key"), {
      actor: "second-admin",
      requestId: "second-stage",
    });

    expect(first.generationId).not.toBe(second.generationId);
    expect(first.state.draft?.model).toBe("first");
    expect(second.state.draft?.model).toBe("second");
    expect(lifecycle.getState().draft?.model).toBe("second");
  });

  it("preserves the draft credential before active and rejects a keyless first config", async () => {
    const { lifecycle } = fixture("credential-inheritance");
    await expect(
      lifecycle.stage(input("first"), { actor: "admin", requestId: "missing" }),
    ).rejects.toThrow("首次配置时必须填写 API Key");

    await lifecycle.stage(input("first", "draft-key"), {
      actor: "admin",
      requestId: "first",
    });
    const second = await lifecycle.stage(input("second"), {
      actor: "admin",
      requestId: "second",
    });
    expect(second.value.keyChanged).toBe(false);
    expect(lifecycle.readDraft()?.apiKey).toBe("draft-key");
  });

  it("rejects stale probe attestation after a concurrent restage", async () => {
    const { lifecycle } = fixture("stale-probe");
    await lifecycle.stage(input("draft-one", "key-one"), {
      actor: "admin",
      requestId: "stage-one",
    });
    const prepared = lifecycle.prepareDraftProbe();
    await lifecycle.stage(input("draft-two", "key-two"), {
      actor: "other-admin",
      requestId: "stage-two",
    });

    await expect(
      lifecycle.markTested({
        actor: "admin",
        requestId: "stale-probe",
        expectedGenerationId: prepared.expectedGenerationId,
        expectedDraftDigest: prepared.expectedDraftDigest,
      }),
    ).rejects.toBeInstanceOf(PlatformRouterConflictError);
    expect(lifecycle.getDraft()).toMatchObject({
      model: "draft-two",
      testedReady: false,
    });
  });

  it("reconciles visible credential directory-fsync uncertainty and rejects invisible bytes", async () => {
    const visibleRoot = caseRoot("credential-visible");
    const visibleStorage = createProtectedPlatformRouterStorage(visibleRoot, {
      fsync: ((descriptor: number) => {
        const stat = readFileDescriptorPath(descriptor);
        if (stat === visibleRoot) throw nodeFailure("EIO", "directory fsync");
        fsyncSync(descriptor);
      }) as typeof fsyncSync,
    });
    const visible = createTransactionalManagedPlatformRouterLifecycle({
      storage: visibleStorage,
      transactionOptions: { root: visibleRoot },
    });
    const result = await visible.stage(input("visible", "visible-key"), {
      actor: "admin",
      requestId: "visible",
    });
    expect(result.committed).toBe(true);
    expect(visible.readDraft()?.apiKey).toBe("visible-key");

    const invisibleRoot = caseRoot("credential-invisible");
    const invisibleStorage = createProtectedPlatformRouterStorage(invisibleRoot, {
      rename: ((source: string, destination: string) => {
        renameSync(source, destination);
        unlinkSync(destination);
      }) as typeof renameSync,
      fsync: ((descriptor: number) => {
        if (readFileDescriptorPath(descriptor) === invisibleRoot) {
          throw nodeFailure("EIO", "directory fsync");
        }
        fsyncSync(descriptor);
      }) as typeof fsyncSync,
    });
    const invisible = createTransactionalManagedPlatformRouterLifecycle({
      storage: invisibleStorage,
      transactionOptions: { root: invisibleRoot },
    });
    await expect(
      invisible.stage(input("invisible", "invisible-key"), {
        actor: "admin",
        requestId: "invisible",
      }),
    ).rejects.toBeInstanceOf(PlatformRouterStorageUncertainError);
    expect(readCurrentSnapshot({ root: invisibleRoot }).active).toBeNull();
    expect(readCurrentSnapshot({ root: invisibleRoot }).draft).toBeNull();
  });

  it("reconciles visible pointer-publication uncertainty and rejects a restored old pointer", async () => {
    const visibleFault = pointerPublicationFault(2, false);
    const visible = fixture("pointer-visible", visibleFault.io);
    const committed = await visible.lifecycle.stage(input("visible", "key"), {
      actor: "admin",
      requestId: "visible-pointer",
    });
    expect(committed.committed).toBe(true);
    expect(visible.lifecycle.getDraft()?.model).toBe("visible");

    const invisibleFault = pointerPublicationFault(2, true);
    const invisible = fixture("pointer-invisible", invisibleFault.io);
    await expect(
      invisible.lifecycle.stage(input("invisible", "key"), {
        actor: "admin",
        requestId: "invisible-pointer",
      }),
    ).rejects.toBeInstanceOf(PlatformRouterStateIndeterminateError);
    expect(readCurrentSnapshot({ root: invisible.root }).draft).toBeNull();
  });

  it("does not acknowledge a later descendant or colliding sibling after uncertain publication", async () => {
    for (const relationship of ["descendant", "sibling"] as const) {
      const root = caseRoot(`uncertain-${relationship}`);
      const io = pointerReconciliationMismatch(root, relationship);
      const lifecycle = createTransactionalManagedPlatformRouterLifecycle({
        storage: createProtectedPlatformRouterStorage(root),
        transactionOptions: { root, io },
      });

      await expect(
        lifecycle.stage(input(`uncertain-${relationship}`, "uncertain-key"), {
          actor: "admin",
          requestId: `uncertain-${relationship}`,
        }),
      ).rejects.toBeInstanceOf(PlatformRouterStateIndeterminateError);

      const visible = readCurrentSnapshot({ root });
      expect(visible.draft?.config.model).toBe(`uncertain-${relationship}`);
      expect(visible.pendingAudit).toHaveLength(1);
      expect(visible.parentGenerationId).not.toBeNull();
      const visibleParent = JSON.parse(
        readFileSync(
          path.join(
            root,
            PLATFORM_ROUTER_GENERATION_DIRECTORY,
            `${visible.parentGenerationId}.json`,
          ),
          "utf8",
        ),
      ) as { pendingAudit: unknown[] };
      expect(visibleParent.pendingAudit).toHaveLength(
        relationship === "descendant" ? 1 : 0,
      );
    }
  });

  it("does not publish state after lock replacement or generation durability failure", async () => {
    const lockRoot = caseRoot("lock-replacement");
    let swapped = false;
    const canonical = path.join(lockRoot, PLATFORM_ROUTER_LOCK_DIRECTORY);
    const parked = path.join(lockRoot, "parked-owned-lock");
    const replacementIo: PlatformRouterIoOverrides = {
      rename: ((source: string, destination: string) => {
        if (
          !swapped &&
          destination.startsWith(
            path.join(lockRoot, PLATFORM_ROUTER_GENERATION_DIRECTORY),
          ) &&
          destination.endsWith(".json") &&
          existsSync(canonical)
        ) {
          renameSync(canonical, parked);
          mkdirSync(canonical, { mode: 0o700 });
          swapped = true;
        }
        renameSync(source, destination);
      }) as typeof renameSync,
    };
    const replaced = createTransactionalManagedPlatformRouterLifecycle({
      storage: createProtectedPlatformRouterStorage(lockRoot),
      transactionOptions: { root: lockRoot, io: replacementIo },
    });
    await expect(
      replaced.stage(input("must-not-publish", "orphan-key"), {
        actor: "admin",
        requestId: "lock-replaced",
      }),
    ).rejects.toBeInstanceOf(PlatformRouterLockOwnershipError);
    expect(readCurrentSnapshot({ root: lockRoot }).draft).toBeNull();
    rmSync(canonical, { recursive: true, force: true });
    rmSync(parked, { recursive: true, force: true });

    const generationRoot = caseRoot("generation-fsync-failure");
    const generationIo = pathAwareIo({
      fsync(target, descriptor) {
        if (
          target ===
          path.join(generationRoot, PLATFORM_ROUTER_GENERATION_DIRECTORY)
        ) {
          throw nodeFailure("EIO", "generation directory fsync");
        }
        fsyncSync(descriptor);
      },
    });
    const generationFailure = createTransactionalManagedPlatformRouterLifecycle({
      storage: createProtectedPlatformRouterStorage(generationRoot),
      transactionOptions: { root: generationRoot, io: generationIo },
    });
    await expect(
      generationFailure.stage(input("must-not-publish", "orphan-key"), {
        actor: "admin",
        requestId: "generation-fsync",
      }),
    ).rejects.toThrow("代际提交失败");
    expect(readCurrentSnapshot({ root: generationRoot }).draft).toBeNull();
  });

  it("keeps a positive partial audit tail pending and byte-for-byte intact", async () => {
    const root = caseRoot("audit-partial-tail");
    let auditWrites = 0;
    const io = pathAwareIo({
      write(target, descriptor, buffer, offset, length, position) {
        if (target === path.join(root, PLATFORM_ROUTER_AUDIT_FILE)) {
          auditWrites += 1;
          if (auditWrites === 1) {
            return writeSync(
              descriptor,
              buffer,
              offset,
              Math.min(17, length),
              position ?? null,
            );
          }
          throw nodeFailure("ENOSPC", "audit full after positive append");
        }
        return writeSync(descriptor, buffer, offset, length, position ?? null);
      },
    });
    const lifecycle = createTransactionalManagedPlatformRouterLifecycle({
      storage: createProtectedPlatformRouterStorage(root),
      transactionOptions: { root, io },
    });
    const result = await lifecycle.stage(input("partial", "partial-key"), {
      actor: "admin",
      requestId: "partial-audit",
    });
    expect(result).toMatchObject({ committed: true, auditPending: true });
    const auditPath = path.join(root, PLATFORM_ROUTER_AUDIT_FILE);
    const partial = readFileSync(auditPath);
    expect(partial.length).toBe(17);
    await expect(
      recoverPlatformRouterTransactions({ root }),
    ).rejects.toBeInstanceOf(PlatformRouterAuditPendingError);
    expect(readFileSync(auditPath)).toEqual(partial);
    expect(readCurrentSnapshot({ root }).pendingAudit).toHaveLength(1);
  });

  it("reports audit fsync and GC deletion failures after the visible commit", async () => {
    const auditRoot = caseRoot("audit-fsync-failure");
    const auditIo = pathAwareIo({
      fsync(target, descriptor) {
        if (target === path.join(auditRoot, PLATFORM_ROUTER_AUDIT_FILE)) {
          throw nodeFailure("EIO", "audit fsync");
        }
        fsyncSync(descriptor);
      },
    });
    const auditLifecycle = createTransactionalManagedPlatformRouterLifecycle({
      storage: createProtectedPlatformRouterStorage(auditRoot),
      transactionOptions: { root: auditRoot, io: auditIo },
    });
    const auditResult = await auditLifecycle.stage(
      input("audit-durable-unknown", "audit-key"),
      { actor: "admin", requestId: "audit-fsync" },
    );
    expect(auditResult).toMatchObject({ committed: true, auditPending: true });
    await recoverPlatformRouterTransactions({ root: auditRoot });
    expect(
      readFileSync(path.join(auditRoot, PLATFORM_ROUTER_AUDIT_FILE), "utf8")
        .trim()
        .split("\n"),
    ).toHaveLength(1);

    const gcRoot = caseRoot("gc-unlink-failure");
    const orphan = `platform-router-key-${randomUuid(999)}.key`;
    let createOrphanAfterCommit = false;
    const gcIo: PlatformRouterIoOverrides = {
      rename: ((source: string, destination: string) => {
        renameSync(source, destination);
        if (
          destination.endsWith(PLATFORM_ROUTER_POINTER_FILE) &&
          !createOrphanAfterCommit &&
          readCurrentSnapshot({ root: gcRoot }).draft
        ) {
          createOrphanAfterCommit = true;
          const orphanPath = path.join(gcRoot, orphan);
          writeFileSync(orphanPath, "orphan\n", { mode: 0o640 });
          utimesSync(orphanPath, new Date(0), new Date(0));
        }
      }) as typeof renameSync,
      unlink: ((target: string) => {
        if (target === path.join(gcRoot, orphan)) {
          throw nodeFailure("EACCES", "gc deletion denied");
        }
        unlinkSync(target);
      }) as typeof unlinkSync,
    };
    const gcLifecycle = createTransactionalManagedPlatformRouterLifecycle({
      storage: createProtectedPlatformRouterStorage(gcRoot),
      transactionOptions: { root: gcRoot, gcGraceMs: 0, io: gcIo },
    });
    const gcResult = await gcLifecycle.stage(input("gc", "gc-key"), {
      actor: "admin",
      requestId: "gc-failure",
    });
    expect(gcResult).toMatchObject({ committed: true, maintenancePending: true });
    expect(readCurrentSnapshot({ root: gcRoot }).draft?.config.model).toBe("gc");
    expect(existsSync(path.join(gcRoot, orphan))).toBe(true);
  });

  it("returns committed auditPending on ENOSPC and recovery replays exactly once", async () => {
    const root = caseRoot("audit-enospc");
    const io = pathAwareIo({
      write(target, descriptor, buffer, offset, length, position) {
        if (target === path.join(root, PLATFORM_ROUTER_AUDIT_FILE)) {
          throw nodeFailure("ENOSPC", "audit full");
        }
        return writeSync(descriptor, buffer, offset, length, position);
      },
    });
    const lifecycle = createTransactionalManagedPlatformRouterLifecycle({
      storage: createProtectedPlatformRouterStorage(root),
      transactionOptions: { root, io },
    });
    const result = await lifecycle.stage(input("pending", "pending-key"), {
      actor: "admin",
      requestId: "audit-pending",
    });
    expect(result).toMatchObject({ committed: true, auditPending: true });
    expect(readCurrentSnapshot({ root }).draft?.config.model).toBe("pending");
    expect(readCurrentSnapshot({ root }).pendingAudit).toHaveLength(1);

    await recoverPlatformRouterTransactions({ root });
    await recoverPlatformRouterTransactions({ root });
    const lines = readFileSync(path.join(root, PLATFORM_ROUTER_AUDIT_FILE), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    expect(readCurrentSnapshot({ root }).pendingAudit).toEqual([]);
  });

  it("returns committed auditPending when checkpoint publication fails", async () => {
    const fault = pointerRenameFailure(3);
    const { root, lifecycle } = fixture("checkpoint-failure", fault.io);
    const result = await lifecycle.stage(input("checkpoint", "checkpoint-key"), {
      actor: "admin",
      requestId: "checkpoint-failure",
    });
    expect(result).toMatchObject({ committed: true, auditPending: true });
    expect(readCurrentSnapshot({ root }).pendingAudit).toHaveLength(1);
    expect(readFileSync(path.join(root, PLATFORM_ROUTER_AUDIT_FILE), "utf8"))
      .toContain("checkpoint-failure");

    await recoverPlatformRouterTransactions({ root });
    expect(readCurrentSnapshot({ root }).pendingAudit).toEqual([]);
    expect(
      readFileSync(path.join(root, PLATFORM_ROUTER_AUDIT_FILE), "utf8")
        .trim()
        .split("\n"),
    ).toHaveLength(1);
  });

  it("makes simultaneous child stages serialize on the exact latest parent", async () => {
    const { root } = fixture("simultaneous-stage");
    const held = await acquirePlatformRouterLock({ root });
    const start = barrier(root, "start");
    const leftResult = barrier(root, "left.json");
    const rightResult = barrier(root, "right.json");
    const left = spawnLifecycleChild([
      "lifecycle-stage",
      root,
      start,
      leftResult,
      "left-model",
      "left-key",
    ]);
    const right = spawnLifecycleChild([
      "lifecycle-stage",
      root,
      start,
      rightResult,
      "right-model",
      "right-key",
    ]);
    writeFileSync(start, "start");
    await delay(100);
    held.release();
    await Promise.all([
      waitForFile(leftResult, left, 12_000),
      waitForFile(rightResult, right, 12_000),
    ]);
    await Promise.all([waitForExit(left), waitForExit(right)]);
    expect(readJson(leftResult)).toMatchObject({ status: "committed" });
    expect(readJson(rightResult)).toMatchObject({ status: "committed" });
    const current = readCurrentSnapshot({ root });
    expect(["left-model", "right-model"]).toContain(current.draft?.config.model);
    expect(current.parentGenerationId).not.toBeNull();
  });

  it("keeps every referenced credential through a real child activate/stage race", async () => {
    const { root, lifecycle } = fixture("activate-stage-race");
    await lifecycle.stage(input("active-a", "key-a"), {
      actor: "admin",
      requestId: "stage-a",
    });
    let prepared = lifecycle.prepareDraftProbe();
    await lifecycle.markTested({
      actor: "admin",
      requestId: "test-a",
      expectedGenerationId: prepared.expectedGenerationId,
      expectedDraftDigest: prepared.expectedDraftDigest,
    });
    await lifecycle.activate({ actor: "admin", requestId: "activate-a" });
    await lifecycle.stage(input("draft-d", "key-d"), {
      actor: "admin",
      requestId: "stage-d",
    });
    prepared = lifecycle.prepareDraftProbe();
    await lifecycle.markTested({
      actor: "admin",
      requestId: "test-d",
      expectedGenerationId: prepared.expectedGenerationId,
      expectedDraftDigest: prepared.expectedDraftDigest,
    });

    const held = await acquirePlatformRouterLock({ root });
    const start = barrier(root, "race-start");
    const activateResult = barrier(root, "activate.json");
    const stageResult = barrier(root, "stage.json");
    const activate = spawnLifecycleChild([
      "lifecycle-activate",
      root,
      start,
      activateResult,
    ]);
    const stage = spawnLifecycleChild([
      "lifecycle-stage",
      root,
      start,
      stageResult,
      "draft-e",
      SENTINEL,
    ]);
    writeFileSync(start, "start");
    await delay(100);
    held.release();
    await Promise.all([
      waitForFile(activateResult, activate, 12_000),
      waitForFile(stageResult, stage, 12_000),
    ]);
    await Promise.all([waitForExit(activate), waitForExit(stage)]);

    const activateOutputText = readFileSync(activateResult, "utf8");
    const stageOutputText = readFileSync(stageResult, "utf8");
    expect(activateOutputText).not.toContain(SENTINEL);
    expect(stageOutputText).not.toContain(SENTINEL);
    const activateOutput = JSON.parse(activateOutputText) as LifecycleChildResult;
    const stageOutput = JSON.parse(stageOutputText) as LifecycleChildResult;
    expect(stageOutput).toMatchObject({
      status: "committed",
      result: { value: { model: "draft-e" } },
    });

    const current = readCurrentSnapshot({ root });
    const activateThenStage =
      activateOutput.status === "committed" &&
      activateOutput.result?.value?.model === "draft-d" &&
      current.active?.model === "draft-d" &&
      current.draft?.config.model === "draft-e";
    const stageThenRejectedActivate =
      activateOutput.status === "error" &&
      activateOutput.errorName === "PlatformRouterConfigValidationError" &&
      current.active?.model === "active-a" &&
      current.draft?.config.model === "draft-e";
    expect([activateThenStage, stageThenRejectedActivate].filter(Boolean))
      .toHaveLength(1);

    const retained = readdirSync(
      path.join(root, PLATFORM_ROUTER_GENERATION_DIRECTORY),
    ).map((generationFile) =>
      JSON.parse(
        readFileSync(
          path.join(root, PLATFORM_ROUTER_GENERATION_DIRECTORY, generationFile),
          "utf8",
        ),
      ) as CredentialReferences,
    );
    const referencedCredentials = [current, ...retained].flatMap((generation) =>
      [
        generation.active?.credentialFile,
        generation.draft?.config?.credentialFile,
      ].filter((value): value is string => typeof value === "string"),
    );
    expect(referencedCredentials.length).toBeGreaterThan(0);
    for (const credentialFile of referencedCredentials) {
      const credentialPath = path.join(root, credentialFile);
      expect(existsSync(credentialPath)).toBe(true);
      expect(readFileSync(credentialPath, "utf8").trim()).not.toBe("");
    }
  });

  it("fails closed on corrupt pointers and credentials but falls back when the pointer is absent", async () => {
    const legacyRoot = caseRoot("legacy-read");
    const legacyCredential = "platform-router.key";
    writeFileSync(path.join(legacyRoot, legacyCredential), "legacy-key\n", { mode: 0o640 });
    writeFileSync(
      path.join(legacyRoot, "platform-router.json"),
      `${JSON.stringify({ ...input("legacy"), credentialFile: legacyCredential })}\n`,
      { mode: 0o640 },
    );
    const legacy = createTransactionalManagedPlatformRouterLifecycle({
      storage: createProtectedPlatformRouterStorage(legacyRoot),
      transactionOptions: { root: legacyRoot },
    });
    expect(legacy.readActive()).toMatchObject({ model: "legacy", apiKey: "legacy-key" });

    writeFileSync(path.join(legacyRoot, PLATFORM_ROUTER_POINTER_FILE), "{}\n", { mode: 0o640 });
    expect(() => legacy.readActive()).toThrow(PlatformRouterCorruptionError);

    const credentialRoot = caseRoot("credential-symlink-read");
    const credentialLifecycle = createTransactionalManagedPlatformRouterLifecycle({
      storage: createProtectedPlatformRouterStorage(credentialRoot),
      transactionOptions: { root: credentialRoot },
    });
    await credentialLifecycle.stage(input("safe", "safe-key"), {
      actor: "admin",
      requestId: "safe",
    });
    const credentialFile = readCurrentSnapshot({ root: credentialRoot }).draft!
      .config.credentialFile;
    unlinkSync(path.join(credentialRoot, credentialFile));
    symlinkSync("/etc/passwd", path.join(credentialRoot, credentialFile));
    expect(() => credentialLifecycle.readDraft()).toThrow(
      PlatformRouterCorruptionError,
    );
  });

  it("times out without mutation while another process owns the lock", async () => {
    const root = caseRoot("lock-timeout");
    const held = await acquirePlatformRouterLock({ root });
    const lifecycle = createTransactionalManagedPlatformRouterLifecycle({
      storage: createProtectedPlatformRouterStorage(root),
      transactionOptions: { root, timeoutMs: 40 },
    });
    await expect(
      lifecycle.stage(input("blocked", "blocked-key"), {
        actor: "admin",
        requestId: "blocked",
      }),
    ).rejects.toBeInstanceOf(PlatformRouterLockTimeoutError);
    held.release();
    expect(readCurrentSnapshot({ root }).draft).toBeNull();
  });
});

interface LifecycleChildResult {
  status: "committed" | "error";
  errorName?: string;
  result?: { value?: { model?: string } };
}

interface CredentialReferences {
  active?: { credentialFile?: string } | null;
  draft?: { config?: { credentialFile?: string } } | null;
}

function pointerReconciliationMismatch(
  root: string,
  relationship: "descendant" | "sibling",
): PlatformRouterIoOverrides {
  let publications = 0;
  let replaceOnRootSync = false;
  return {
    rename: ((source: string, destination: string) => {
      renameSync(source, destination);
      if (destination === path.join(root, PLATFORM_ROUTER_POINTER_FILE)) {
        publications += 1;
        replaceOnRootSync = publications === 2;
      }
    }) as typeof renameSync,
    fsync: ((descriptor: number) => {
      if (replaceOnRootSync && readFileDescriptorPath(descriptor) === root) {
        replaceOnRootSync = false;
        const pointerPath = path.join(root, PLATFORM_ROUTER_POINTER_FILE);
        const attemptedPointer = JSON.parse(
          readFileSync(pointerPath, "utf8"),
        ) as { generationId: string };
        const generationDirectory = path.join(
          root,
          PLATFORM_ROUTER_GENERATION_DIRECTORY,
        );
        const attempted = JSON.parse(
          readFileSync(
            path.join(generationDirectory, `${attemptedPointer.generationId}.json`),
            "utf8",
          ),
        ) as { parentGenerationId: string | null } & Record<string, unknown>;
        const replacementId = randomUuid(
          relationship === "descendant" ? 901 : 902,
        );
        const replacement = {
          ...attempted,
          generationId: replacementId,
          parentGenerationId:
            relationship === "descendant"
              ? attemptedPointer.generationId
              : attempted.parentGenerationId,
        };
        const generationBytes = Buffer.from(`${JSON.stringify(replacement)}\n`);
        writeFileSync(
          path.join(generationDirectory, `${replacementId}.json`),
          generationBytes,
          { mode: 0o640 },
        );
        writeFileSync(
          pointerPath,
          `${JSON.stringify({
            schemaVersion: 1,
            generationId: replacementId,
            sha256: createHash("sha256").update(generationBytes).digest("hex"),
          })}\n`,
          { mode: 0o640 },
        );
        throw nodeFailure("EIO", "pointer directory fsync");
      }
      fsyncSync(descriptor);
    }) as typeof fsyncSync,
  };
}

function pointerPublicationFault(
  publicationToFail: number,
  restoreOldPointer: boolean,
): { io: PlatformRouterIoOverrides } {
  let publications = 0;
  let throwNextRootSync = false;
  const oldPointers: Buffer[] = [];
  const paths = new Map<number, string>();
  return {
    io: {
      open: ((target, flags, mode) => {
        const descriptor = openSync(target, flags, mode);
        paths.set(descriptor, String(target));
        return descriptor;
      }) as typeof openSync,
      rename: ((source: string, destination: string) => {
        if (destination.endsWith(PLATFORM_ROUTER_POINTER_FILE)) {
          publications += 1;
          oldPointers.push(
            existsSync(destination) ? readFileSync(destination) : Buffer.alloc(0),
          );
        }
        renameSync(source, destination);
        if (
          destination.endsWith(PLATFORM_ROUTER_POINTER_FILE) &&
          publications === publicationToFail
        ) {
          if (restoreOldPointer) {
            const old = oldPointers.at(-1)!;
            if (old.length) writeFileSync(destination, old);
            else unlinkSync(destination);
          }
          throwNextRootSync = true;
        }
      }) as typeof renameSync,
      fsync: ((descriptor: number) => {
        const target = paths.get(descriptor);
        if (throwNextRootSync && target && !path.basename(target).includes(".")) {
          throwNextRootSync = false;
          throw nodeFailure("EIO", "pointer directory fsync");
        }
        fsyncSync(descriptor);
      }) as typeof fsyncSync,
    },
  };
}

function pointerRenameFailure(publicationToFail: number): {
  io: PlatformRouterIoOverrides;
} {
  let publications = 0;
  return {
    io: {
      rename: ((source: string, destination: string) => {
        if (destination.endsWith(PLATFORM_ROUTER_POINTER_FILE)) {
          publications += 1;
          if (publications === publicationToFail) {
            throw nodeFailure("ENOSPC", "checkpoint pointer rename");
          }
        }
        renameSync(source, destination);
      }) as typeof renameSync,
    },
  };
}

function pathAwareIo(callbacks: {
  fsync?: (target: string, descriptor: number) => void;
  write?: (
    target: string,
    descriptor: number,
    buffer: NodeJS.ArrayBufferView,
    offset: number,
    length: number,
    position: number | null | undefined,
  ) => number;
}): PlatformRouterIoOverrides {
  const paths = new Map<number, string>();
  return {
    open: ((target, flags, mode) => {
      const descriptor = openSync(target, flags, mode);
      paths.set(descriptor, String(target));
      return descriptor;
    }) as typeof openSync,
    fsync: ((descriptor: number) => {
      const target = paths.get(descriptor) ?? "unknown";
      if (callbacks.fsync) callbacks.fsync(target, descriptor);
      else fsyncSync(descriptor);
    }) as typeof fsyncSync,
    write: ((descriptor, buffer, offset, length, position) =>
      callbacks.write
        ? callbacks.write(
            paths.get(descriptor) ?? "unknown",
            descriptor,
            buffer,
            offset ?? 0,
            length ?? buffer.byteLength,
            position ?? null,
          )
        : writeSync(
            descriptor,
            buffer,
            offset ?? 0,
            length ?? buffer.byteLength,
            position ?? null,
          )) as typeof writeSync,
  };
}

function readFileDescriptorPath(descriptor: number): string {
  return readlinkSync(`/proc/self/fd/${descriptor}`).replace(/ \(deleted\)$/, "");
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

function spawnLifecycleChild(arguments_: string[]): ChildProcess {
  const child = spawn("bun", [CHILD_FIXTURE, ...arguments_], {
    cwd: WEB_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  return child;
}

async function waitForFile(
  target: string,
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(target)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`child exited before ${target}`);
    }
    if (Date.now() >= deadline) throw new Error(`barrier timeout: ${target}`);
    await delay(10);
  }
}

async function waitForExit(child: ChildProcess, timeoutMs = 8_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child exit timeout")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function readJson(target: string): unknown {
  return JSON.parse(readFileSync(target, "utf8"));
}

function randomUuid(number: number): string {
  return `00000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;
}

function nodeFailure(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

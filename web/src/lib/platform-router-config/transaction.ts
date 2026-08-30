import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import {
  decodePlatformRouterAuditRecord,
  normalizeAuditEventId,
  PLATFORM_ROUTER_AUDIT_FILE,
  type PlatformRouterAuditRecord,
} from "./audit";
import {
  boundedAuditText,
  decodeStoredRouterConfig,
  isRecord,
  LEGACY_ROUTER_KEY_FILE,
  MANAGED_ROUTER_KEY_FILE,
  normalizeStoredRouterConfig,
  type DraftMetadata,
  type DraftTestAttestation,
  type NormalizedStoredRouterConfig,
  type StoredRouterConfig,
  type StoredRouterDraft,
} from "./contract";
import { PLATFORM_ROUTER_SECRET_ROOT } from "./protected-storage";

export const PLATFORM_ROUTER_POINTER_FILE = "platform-router.current";
export const PLATFORM_ROUTER_GENERATION_DIRECTORY =
  "platform-router.generations";
export const PLATFORM_ROUTER_LOCK_DIRECTORY = "platform-router.tx.lock";
export const PLATFORM_ROUTER_LOCK_OWNER_FILE = "owner.json";

const GENERATION_SCHEMA_VERSION = 1;
const POINTER_SCHEMA_VERSION = 1;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_OWNER_CREATION_GRACE_MS = 250;
const DEFAULT_GC_GRACE_MS = 5 * 60_000;
const MAX_GENERATION_LINEAGE_DEPTH = 10_000;
const MAX_STATE_BYTES = 1024 * 1024;
export const MAX_PENDING_AUDIT_RECORDS = 1_024;
const AUDIT_SCAN_CHUNK_BYTES = 64 * 1024;
const MAX_AUDIT_RECORD_BYTES = 64 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BOOT_ID_PATTERN = /^[0-9a-f-]{16,64}$/i;
const START_TICKS_PATTERN = /^[0-9]+$/;
const POINTER_TEMP_PATTERN =
  /^\.platform-router\.current\.([0-9a-f-]{36})\.tmp$/i;
const GENERATION_FILE_PATTERN = /^([0-9a-f-]{36})\.json$/i;
const GENERATION_TEMP_PATTERN =
  /^\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.tmp$/i;
const LOCK_CANDIDATE_PATTERN =
  /^\.platform-router\.tx\.lock\.candidate-([0-9a-f-]{36})$/i;
const LOCK_RELEASED_PATTERN =
  /^\.platform-router\.tx\.lock\.released-([0-9a-f-]{36})$/i;
const LOCK_RECOVERY_CLAIM_PATTERN =
  /^\.recovery-claim-([0-9a-f-]{36}|[0-9a-f]{64})$/i;
interface LockCapability {
  descriptor: number;
  device: number;
  inode: number;
  nonce: string;
  ownerBytes: Buffer;
  released: boolean;
  publicationUncertain: boolean;
}

interface DirectoryIdentity {
  device: number;
  inode: number;
}

const lockCapabilities = new WeakMap<object, LockCapability>();

interface PlatformRouterPointer {
  schemaVersion: 1;
  generationId: string;
  sha256: string;
}

interface PlatformRouterGeneration {
  schemaVersion: 1;
  generationId: string;
  parentGenerationId: string | null;
  committedAt: string;
  active: NormalizedStoredRouterConfig | null;
  draft: StoredRouterDraft | null;
  pendingAudit: PlatformRouterAuditRecord[];
}

export interface PlatformRouterSnapshot {
  source: "generation" | "legacy" | "empty";
  pointer: PlatformRouterPointer | null;
  generationId: string | null;
  parentGenerationId: string | null;
  committedAt: string | null;
  active: NormalizedStoredRouterConfig | null;
  draft: StoredRouterDraft | null;
  pendingAudit: PlatformRouterAuditRecord[];
}

export interface PlatformRouterGenerationInput {
  generationId?: string;
  parentGenerationId: string | null;
  committedAt?: string;
  active: StoredRouterConfig | null;
  draft: StoredRouterDraft | null;
  pendingAudit: PlatformRouterAuditRecord[];
}

interface PlatformRouterLockOwner {
  pid: number;
  bootId: string;
  startTicks: string;
  nonce: string;
  acquiredAt: string;
}

export interface PlatformRouterLockHandle {
  readonly owner: PlatformRouterLockOwner;
  readonly root: string;
  readonly publicationUncertain: boolean;
  release(): void;
}

export interface PlatformRouterAuditFlushResult {
  deliveredEventIds: string[];
  appendedEventIds: string[];
  repairedTail: boolean;
}

export interface PlatformRouterGarbageCollectionResult {
  retainedGenerations: string[];
  removedGenerations: string[];
  removedCredentials: string[];
}

export interface PlatformRouterRecoveryResult {
  importedLegacy: boolean;
  snapshot: PlatformRouterSnapshot;
  audit: PlatformRouterAuditFlushResult;
  garbageCollection: PlatformRouterGarbageCollectionResult;
}

export interface PlatformRouterIoOverrides {
  open?: typeof openSync;
  write?: typeof writeSync;
  fsync?: typeof fsyncSync;
  ftruncate?: typeof ftruncateSync;
  lstat?: typeof lstatSync;
  rename?: typeof renameSync;
  unlink?: typeof unlinkSync;
}

export interface PlatformRouterTransactionOptions {
  root?: string;
  timeoutMs?: number;
  creationGraceMs?: number;
  gcGraceMs?: number;
  now?: () => Date;
  nowMs?: () => number;
  monotonicNowMs?: () => number;
  nextId?: () => string;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  pid?: number;
  readBootId?: () => string;
  readProcessStartTicks?: (pid: number) => string | null;
  beforeStaleTakeover?: () => Promise<void> | void;
  io?: PlatformRouterIoOverrides;
}

export class PlatformRouterTransactionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}
export class PlatformRouterValidationError extends PlatformRouterTransactionError {}
export class PlatformRouterCorruptionError extends PlatformRouterTransactionError {}
export class PlatformRouterConflictError extends PlatformRouterTransactionError {}
export class PlatformRouterLockTimeoutError extends PlatformRouterTransactionError {}
export class PlatformRouterLockOwnershipError extends PlatformRouterTransactionError {}
export class PlatformRouterCommitUncertainError extends PlatformRouterTransactionError {}
export class PlatformRouterAuditPendingError extends PlatformRouterCorruptionError {}

type ParsedJson =
  | null
  | boolean
  | number
  | string
  | ParsedJson[]
  | { [key: string]: ParsedJson };

interface ResolvedEnvironment {
  root: string;
  now: () => Date;
  nowMs: () => number;
  monotonicNowMs: () => number;
  nextId: () => string;
  random: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  pid: number;
  readBootId: () => string;
  readProcessStartTicks: (pid: number) => string | null;
  beforeStaleTakeover: () => Promise<void> | void;
  io: Required<PlatformRouterIoOverrides>;
}

interface LockInspection {
  descriptor: number;
  device: number;
  inode: number;
  modifiedAtMs: number;
  ownerBytes: Buffer | null;
  owner: PlatformRouterLockOwner | null;
  stale: boolean;
}

export async function acquirePlatformRouterLock(
  options: PlatformRouterTransactionOptions = {},
): Promise<PlatformRouterLockHandle> {
  const environment = resolveEnvironment(options);
  assertTrustedDirectory(environment.root, "AI 事务根目录无效");
  const timeoutMs = boundedDuration(
    options.timeoutMs,
    DEFAULT_LOCK_TIMEOUT_MS,
    0,
    60_000,
  );
  const creationGraceMs = boundedDuration(
    options.creationGraceMs,
    DEFAULT_OWNER_CREATION_GRACE_MS,
    25,
    5_000,
  );
  const startedAt = environment.monotonicNowMs();
  const lockPath = path.join(environment.root, PLATFORM_ROUTER_LOCK_DIRECTORY);

  for (;;) {
    const owner = createLockOwner(environment);
    const candidatePath = path.join(
      environment.root,
      `.platform-router.tx.lock.candidate-${owner.nonce}`,
    );
    let candidateIdentity: DirectoryIdentity | null = null;
    let published = false;
    try {
      mkdirSync(candidatePath, { mode: 0o700 });
      const candidateStat = environment.io.lstat(candidatePath);
      if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
        throw new PlatformRouterCorruptionError("AI 配置事务锁候选路径无效");
      }
      candidateIdentity = {
        device: candidateStat.dev,
        inode: candidateStat.ino,
      };
      chmodSync(candidatePath, 0o700);
      writeExclusiveFile(
        path.join(candidatePath, PLATFORM_ROUTER_LOCK_OWNER_FILE),
        Buffer.from(`${JSON.stringify(owner)}\n`),
        0o600,
        environment,
      );
      fsyncDirectory(candidatePath, environment);
      assertAbsent(lockPath, "AI 配置事务锁已被其他进程持有");
      environment.io.rename(candidatePath, lockPath);
      published = true;
      const handle = createLockHandle(owner, environment, candidateIdentity);
      try {
        fsyncDirectory(environment.root, environment);
      } catch (cause) {
        try {
          releasePlatformRouterLock(handle, environment, false);
        } catch (cleanupCause) {
          try {
            assertPlatformRouterLockOwned(handle, environment);
            const capability = lockCapabilities.get(handle);
            if (capability) capability.publicationUncertain = true;
            return handle;
          } catch (ownershipCause) {
            throw new PlatformRouterTransactionError(
              "AI 配置事务锁发布同步失败且无法安全回滚",
              { cause: new AggregateError([cause, cleanupCause, ownershipCause]) },
            );
          }
        }
        throw cause;
      }
      return handle;
    } catch (cause) {
      if (!published && candidateIdentity !== null) {
        removeLockArtifact(
          candidatePath,
          "candidate",
          candidateIdentity,
          environment,
        );
      }
      if (
        !(cause instanceof PlatformRouterConflictError) &&
        !isNodeErrorCode(cause, "EEXIST") &&
        !isNodeErrorCode(cause, "ENOTEMPTY")
      ) {
        if (cause instanceof PlatformRouterTransactionError) throw cause;
        throw new PlatformRouterTransactionError("AI 配置事务锁无法创建", {
          cause,
        });
      }
    }

    const inspection = inspectLockStaleness(
      lockPath,
      creationGraceMs,
      environment,
    );
    if (inspection === null) continue;
    try {
      if (inspection.stale) {
        await environment.beforeStaleTakeover();
        const recovered = takeOverStaleLock(
          lockPath,
          inspection,
          createLockOwner(environment),
          creationGraceMs,
          environment,
        );
        if (recovered) return recovered;
        continue;
      }
    } finally {
      closeSync(inspection.descriptor);
    }

    const elapsed = Math.max(0, environment.monotonicNowMs() - startedAt);
    if (elapsed >= timeoutMs) {
      throw new PlatformRouterLockTimeoutError("AI 配置事务锁等待超时");
    }
    const jitter = 25 + Math.floor(environment.random() * 76);
    await environment.sleep(Math.max(1, Math.min(jitter, timeoutMs - elapsed)));
  }
}

export async function withPlatformRouterLock<T>(
  operation: (handle: PlatformRouterLockHandle) => Promise<T> | T,
  options: PlatformRouterTransactionOptions = {},
): Promise<T> {
  const handle = await acquirePlatformRouterLock(options);
  try {
    return await operation(handle);
  } finally {
    handle.release();
  }
}

export function readCurrentSnapshot(
  options: PlatformRouterTransactionOptions = {},
): PlatformRouterSnapshot {
  const environment = resolveEnvironment(options);
  assertTrustedDirectory(environment.root, "AI 事务根目录无效");
  const pointerPath = path.join(environment.root, PLATFORM_ROUTER_POINTER_FILE);
  const pointerBytes = readRegularFile(pointerPath, true, environment);
  if (pointerBytes === null) return readLegacySnapshot(environment);

  let pointer: PlatformRouterPointer;
  try {
    pointer = decodePointer(parseStrictJson(pointerBytes));
  } catch (cause) {
    throw new PlatformRouterCorruptionError("AI 配置当前指针损坏", { cause });
  }
  const generationPath = generationPathFor(pointer.generationId, environment);
  const generationBytes = readRegularFile(generationPath, false, environment)!;
  const actualHash = createHash("sha256").update(generationBytes).digest("hex");
  if (actualHash !== pointer.sha256) {
    throw new PlatformRouterCorruptionError("AI 配置代际校验失败");
  }
  let generation: PlatformRouterGeneration;
  try {
    generation = decodeGeneration(parseStrictJson(generationBytes));
  } catch (cause) {
    throw new PlatformRouterCorruptionError("AI 配置代际损坏", { cause });
  }
  if (generation.generationId !== pointer.generationId) {
    throw new PlatformRouterCorruptionError("AI 配置代际身份不匹配");
  }
  return snapshotFromGeneration(generation, pointer);
}

export function commitGeneration(
  input: PlatformRouterGenerationInput,
  handle: PlatformRouterLockHandle,
  options: PlatformRouterTransactionOptions = {},
): PlatformRouterSnapshot {
  const environment = resolveHandleEnvironment(handle, options);
  assertPlatformRouterLockOwned(handle, environment);
  const generationId = normalizeUuid(input.generationId ?? environment.nextId());
  const parentGenerationId =
    input.parentGenerationId === null
      ? null
      : normalizeUuid(input.parentGenerationId);
  const committedAt = normalizeIsoInstant(
    input.committedAt ?? environment.now().toISOString(),
  );
  const generation = decodeGeneration({
    schemaVersion: GENERATION_SCHEMA_VERSION,
    generationId,
    parentGenerationId,
    committedAt,
    active: input.active,
    draft: input.draft,
    pendingAudit: input.pendingAudit,
  });
  const generationBytes = Buffer.from(`${JSON.stringify(generation)}\n`);
  if (generationBytes.length > MAX_STATE_BYTES) {
    throw new PlatformRouterValidationError("AI 配置代际超过大小限制");
  }
  const expectedPointer = validateCommitParent(
    generationId,
    parentGenerationId,
    environment,
  );
  const pointer: PlatformRouterPointer = {
    schemaVersion: POINTER_SCHEMA_VERSION,
    generationId,
    sha256: createHash("sha256").update(generationBytes).digest("hex"),
  };
  const pointerBytes = Buffer.from(`${JSON.stringify(pointer)}\n`);
  assertPlatformRouterLockOwned(handle, environment);
  const generationDirectory = ensureGenerationDirectory(environment);
  const generationPath = generationPathFor(generationId, environment);
  const generationTemporary = path.join(
    generationDirectory,
    `.${generationId}.${normalizeUuid(environment.nextId())}.tmp`,
  );
  const pointerTemporary = path.join(
    environment.root,
    `.platform-router.current.${normalizeUuid(environment.nextId())}.tmp`,
  );
  const pointerPath = path.join(environment.root, PLATFORM_ROUTER_POINTER_FILE);
  let pointerRenamed = false;

  try {
    assertAbsent(generationPath, "AI 配置代际已存在");
    assertPlatformRouterLockOwned(handle, environment);
    writeExclusiveFile(generationTemporary, generationBytes, 0o640, environment);
    assertPlatformRouterLockOwned(handle, environment);
    environment.io.rename(generationTemporary, generationPath);
    fsyncDirectory(generationDirectory, environment);

    assertRegularPathIfPresent(pointerPath, "AI 配置当前指针路径无效");
    assertPlatformRouterLockOwned(handle, environment);
    writeExclusiveFile(pointerTemporary, pointerBytes, 0o640, environment);
    assertPlatformRouterLockOwned(handle, environment);
    assertPointerUnchanged(expectedPointer, environment);
    environment.io.rename(pointerTemporary, pointerPath);
    pointerRenamed = true;
    try {
      fsyncDirectory(environment.root, environment);
    } catch (cause) {
      throw new PlatformRouterCommitUncertainError(
        "AI 配置指针已切换但目录同步失败",
        { cause },
      );
    }
    return snapshotFromGeneration(generation, pointer);
  } catch (cause) {
    try {
      assertPlatformRouterLockOwned(handle, environment);
      removeRecognizedTemporary(generationTemporary, environment);
      assertPlatformRouterLockOwned(handle, environment);
      removeRecognizedTemporary(pointerTemporary, environment);
    } catch (cleanupCause) {
      if (!(cleanupCause instanceof PlatformRouterLockOwnershipError)) {
        throw cleanupCause;
      }
    }
    if (pointerRenamed || cause instanceof PlatformRouterCommitUncertainError) {
      throw cause;
    }
    if (cause instanceof PlatformRouterTransactionError) throw cause;
    throw new PlatformRouterTransactionError("AI 配置代际提交失败", { cause });
  }
}

export function flushAuditOutbox(
  snapshot: PlatformRouterSnapshot,
  handle: PlatformRouterLockHandle,
  options: PlatformRouterTransactionOptions = {},
): PlatformRouterAuditFlushResult {
  const environment = resolveHandleEnvironment(handle, options);
  assertPlatformRouterLockOwned(handle, environment);
  const auditPath = path.join(environment.root, PLATFORM_ROUTER_AUDIT_FILE);
  const pending = snapshot.pendingAudit.map((record) =>
    decodePlatformRouterAuditRecord(record),
  );
  const wantedEventIds = new Set(pending.map((record) => record.eventId));
  const scan = scanAndRepairAuditJournal(
    auditPath,
    wantedEventIds,
    environment,
  );
  assertPlatformRouterLockOwned(handle, environment);
  const appendedEventIds: string[] = [];
  const missing = pending.filter((record) => {
    const existing = scan.records.get(record.eventId);
    if (!existing) return true;
    if (JSON.stringify(existing) !== JSON.stringify(record)) {
      throw new PlatformRouterCorruptionError(
        "AI 配置审计事件 ID 内容冲突",
      );
    }
    return false;
  });

  if (missing.length > 0) {
    const existed = pathExists(auditPath);
    let descriptor: number | null = null;
    try {
      assertRegularPathIfPresent(auditPath, "AI 配置审计路径无效");
      assertPlatformRouterLockOwned(handle, environment);
      descriptor = environment.io.open(
        auditPath,
        fsConstants.O_APPEND |
          fsConstants.O_CREAT |
          fsConstants.O_WRONLY |
          fsConstants.O_NOFOLLOW,
        0o640,
      );
      if (!fstatSync(descriptor).isFile()) {
        throw new PlatformRouterCorruptionError("AI 配置审计路径无效");
      }
      assertPlatformRouterLockOwned(handle, environment);
      fchmodSync(descriptor, 0o640);
      assertPlatformRouterLockOwned(handle, environment);
      for (const record of missing) {
        assertPlatformRouterLockOwned(handle, environment);
        writeAll(
          descriptor,
          Buffer.from(`${JSON.stringify(record)}\n`),
          environment,
        );
        appendedEventIds.push(record.eventId);
      }
      assertPlatformRouterLockOwned(handle, environment);
      environment.io.fsync(descriptor);
      if (!existed) fsyncDirectory(environment.root, environment);
    } catch (cause) {
      if (cause instanceof PlatformRouterTransactionError) throw cause;
      throw new PlatformRouterTransactionError("AI 配置审计投影失败", {
        cause,
      });
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
  }

  return {
    deliveredEventIds: pending.map((record) => record.eventId),
    appendedEventIds,
    repairedTail: scan.repairedTail,
  };
}

export function checkpointDeliveredAudit(
  snapshot: PlatformRouterSnapshot,
  deliveredEventIds: Iterable<string>,
  handle: PlatformRouterLockHandle,
  options: PlatformRouterTransactionOptions = {},
): PlatformRouterSnapshot {
  const environment = resolveHandleEnvironment(handle, options);
  assertPlatformRouterLockOwned(handle, environment);
  if (snapshot.source !== "generation" || snapshot.generationId === null) {
    throw new PlatformRouterConflictError(
      "AI 配置审计检查点要求已提交代际",
    );
  }
  const current = readCurrentSnapshot({ ...options, root: handle.root });
  if (
    current.source !== "generation" ||
    current.generationId !== snapshot.generationId
  ) {
    throw new PlatformRouterConflictError("AI 配置审计检查点已过期");
  }
  const delivered = new Set(
    [...deliveredEventIds].map((eventId) => normalizeAuditEventId(eventId)),
  );
  const remaining = current.pendingAudit.filter(
    (record) => !delivered.has(record.eventId),
  );
  assertPlatformRouterLockOwned(handle, environment);
  if (remaining.length === current.pendingAudit.length) return current;
  return commitGeneration(
    {
      parentGenerationId: current.generationId,
      active: current.active,
      draft: current.draft,
      pendingAudit: remaining,
    },
    handle,
    options,
  );
}

export async function recoverPlatformRouterTransactions(
  options: PlatformRouterTransactionOptions = {},
): Promise<PlatformRouterRecoveryResult> {
  return withPlatformRouterLock(async (handle) => {
    let snapshot = readCurrentSnapshot(options);
    const importedLegacy = snapshot.source !== "generation";
    validateReferencedCredentials(snapshot, options);
    if (importedLegacy) {
      snapshot = commitGeneration(
        {
          parentGenerationId: null,
          active: snapshot.active,
          draft: snapshot.draft,
          pendingAudit: snapshot.pendingAudit,
        },
        handle,
        options,
      );
    }

    const audit = flushAuditOutbox(snapshot, handle, options);
    snapshot = checkpointDeliveredAudit(
      snapshot,
      audit.deliveredEventIds,
      handle,
      options,
    );
    validateReferencedCredentials(snapshot, options);
    // B2b-ops post-drain owns recognized temp-orphan cleanup. Until every
    // pre-cutover Web writer is drained, recovery must leave those files alone.
    const garbageCollection = garbageCollectPlatformRouterArtifacts(handle, options);
    return { importedLegacy, snapshot, audit, garbageCollection };
  }, options);
}

export function garbageCollectPlatformRouterArtifacts(
  handle: PlatformRouterLockHandle,
  options: PlatformRouterTransactionOptions = {},
): PlatformRouterGarbageCollectionResult {
  const environment = resolveHandleEnvironment(handle, options);
  assertPlatformRouterLockOwned(handle, environment);
  const current = readCurrentSnapshot({ ...options, root: handle.root });
  if (current.source !== "generation" || current.generationId === null) {
    throw new PlatformRouterConflictError("AI 配置垃圾回收要求已提交代际");
  }
  const generationDirectory = path.join(
    environment.root,
    PLATFORM_ROUTER_GENERATION_DIRECTORY,
  );
  assertTrustedDirectory(generationDirectory, "AI 配置代际目录无效");
  const graceCutoff = environment.nowMs() - boundedDuration(
    options.gcGraceMs,
    DEFAULT_GC_GRACE_MS,
    0,
    7 * 24 * 60 * 60_000,
  );
  const retained = new Set<string>();
  const credentialGenerations = new Map<string, PlatformRouterGeneration>();
  const visited = new Set<string>();
  let nextGenerationId: string | null = current.generationId;
  let depth = 0;

  // Validate the complete lineage before any deletion. Only the current
  // generation and two predecessors retain credentials by lineage policy.
  while (nextGenerationId !== null) {
    if (depth >= MAX_GENERATION_LINEAGE_DEPTH) {
      throw new PlatformRouterCorruptionError("AI 配置代际父链超过安全深度限制");
    }
    if (visited.has(nextGenerationId)) {
      throw new PlatformRouterCorruptionError("AI 配置代际父链包含循环");
    }
    visited.add(nextGenerationId);
    const generation = readGenerationWithoutPointer(nextGenerationId, environment);
    if (depth < 3) {
      retained.add(generation.generationId);
      credentialGenerations.set(generation.generationId, generation);
    }
    nextGenerationId = generation.parentGenerationId;
    depth += 1;
  }

  const generationEntries = readdirSync(generationDirectory);
  for (const entry of generationEntries) {
    const match = GENERATION_FILE_PATTERN.exec(entry);
    if (!match) continue;
    const generationId = normalizeUuid(match[1]);
    const candidate = path.join(generationDirectory, entry);
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new PlatformRouterCorruptionError("AI 配置代际路径无效");
    }
    if (stat.mtimeMs >= graceCutoff) {
      const generation = readGenerationWithoutPointer(generationId, environment);
      retained.add(generationId);
      credentialGenerations.set(generationId, generation);
    }
  }

  const referencedCredentials = new Set<string>();
  for (const generation of credentialGenerations.values()) {
    markGenerationCredentials(generation, referencedCredentials);
  }
  const legacy = readLegacySnapshot(environment);
  markSnapshotCredentials(legacy, referencedCredentials);
  referencedCredentials.add(LEGACY_ROUTER_KEY_FILE);

  // Generation JSON is immutable history and is never auto-deleted. Only
  // unreferenced, old managed credentials are eligible for collection.
  const removedCredentials: string[] = [];
  const rootEntries = readdirSync(environment.root);
  assertPlatformRouterLockOwned(handle, environment);
  for (const entry of rootEntries) {
    if (!MANAGED_ROUTER_KEY_FILE.test(entry) || referencedCredentials.has(entry)) {
      continue;
    }
    const candidate = path.join(environment.root, entry);
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new PlatformRouterCorruptionError("AI 配置凭据路径无效");
    }
    if (stat.mtimeMs >= graceCutoff) continue;
    assertPlatformRouterLockOwned(handle, environment);
    environment.io.unlink(candidate);
    removedCredentials.push(entry);
  }
  if (removedCredentials.length > 0) fsyncDirectory(environment.root, environment);

  return {
    retainedGenerations: [...retained].sort(),
    removedGenerations: [],
    removedCredentials: removedCredentials.sort(),
  };
}

export function validateReferencedCredentials(
  snapshot: Pick<PlatformRouterSnapshot, "active" | "draft">,
  options: PlatformRouterTransactionOptions = {},
): void {
  const environment = resolveEnvironment(options);
  const referenced = new Set<string>();
  markSnapshotCredentials(snapshot, referenced);
  for (const credentialFile of referenced) {
    const normalized = normalizeCredentialName(credentialFile);
    const credentialPath = path.join(
      /* turbopackIgnore: true */ environment.root,
      normalized,
    );
    let descriptor: number | null = null;
    try {
      assertRegularPathIfPresent(credentialPath, "AI 配置凭据路径无效");
      descriptor = environment.io.open(
        credentialPath,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.size <= 0) {
        throw new PlatformRouterCorruptionError("AI 配置引用的凭据无效");
      }
    } catch (cause) {
      if (cause instanceof PlatformRouterTransactionError) throw cause;
      throw new PlatformRouterCorruptionError("AI 配置引用的凭据不可用", {
        cause,
      });
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
  }
}

function assertPlatformRouterLockOwned(
  handle: PlatformRouterLockHandle,
  environment: ResolvedEnvironment,
): void {
  const capability = lockCapabilities.get(handle);
  if (
    capability === undefined ||
    capability.released ||
    handle.root !== environment.root
  ) {
    throw new PlatformRouterLockOwnershipError(
      "AI 配置事务锁能力无效、已释放或根目录不匹配",
    );
  }
  const lockPath = path.join(
    environment.root,
    PLATFORM_ROUTER_LOCK_DIRECTORY,
  );
  try {
    const heldStat = fstatSync(capability.descriptor);
    if (
      !heldStat.isDirectory() ||
      heldStat.dev !== capability.device ||
      heldStat.ino !== capability.inode ||
      !sameLockDirectory(
        lockPath,
        capability.device,
        capability.inode,
        environment,
      )
    ) {
      throw new PlatformRouterLockOwnershipError(
        "AI 配置事务锁规范目录身份已改变",
      );
    }
    const actual = readLockOwnerState(
      path.join(
        `/proc/self/fd/${capability.descriptor}`,
        PLATFORM_ROUTER_LOCK_OWNER_FILE,
      ),
      environment,
    );
    if (
      actual?.owner === null ||
      actual === null ||
      !actual.bytes.equals(capability.ownerBytes) ||
      actual.owner.nonce !== capability.nonce ||
      handle.owner.nonce !== capability.nonce
    ) {
      throw new PlatformRouterLockOwnershipError(
        "AI 配置事务锁所有者字节或 nonce 已改变",
      );
    }
  } catch (cause) {
    if (cause instanceof PlatformRouterLockOwnershipError) throw cause;
    throw new PlatformRouterLockOwnershipError(
      "AI 配置事务锁所有权无法确认",
      { cause },
    );
  }
}

function createLockHandle(
  owner: PlatformRouterLockOwner,
  environment: ResolvedEnvironment,
  expectedIdentity?: DirectoryIdentity,
): PlatformRouterLockHandle {
  const lockPath = path.join(
    environment.root,
    PLATFORM_ROUTER_LOCK_DIRECTORY,
  );
  let descriptor: number | null = null;
  try {
    descriptor = environment.io.open(
      lockPath,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const stat = fstatSync(descriptor);
    const ownerBytes = Buffer.from(`${JSON.stringify(owner)}\n`);
    const actual = readLockOwnerState(
      path.join(`/proc/self/fd/${descriptor}`, PLATFORM_ROUTER_LOCK_OWNER_FILE),
      environment,
    );
    if (
      !stat.isDirectory() ||
      (expectedIdentity !== undefined &&
        (stat.dev !== expectedIdentity.device || stat.ino !== expectedIdentity.inode)) ||
      !sameLockDirectory(lockPath, stat.dev, stat.ino, environment) ||
      actual?.owner === null ||
      actual === null ||
      !actual.bytes.equals(ownerBytes) ||
      actual.owner.nonce !== owner.nonce
    ) {
      throw new PlatformRouterLockOwnershipError(
        "AI 配置事务锁发布后的目录或所有者身份不匹配",
      );
    }
    const capability: LockCapability = {
      descriptor,
      device: stat.dev,
      inode: stat.ino,
      nonce: owner.nonce,
      ownerBytes: Buffer.from(actual.bytes),
      released: false,
      publicationUncertain: false,
    };
    const frozenOwner = Object.freeze({ ...owner });
    const handle: PlatformRouterLockHandle = {
      owner: frozenOwner,
      root: environment.root,
      get publicationUncertain() {
        return capability.publicationUncertain;
      },
      release() {
        if (capability.released) return;
        releasePlatformRouterLock(handle, environment, true);
      },
    };
    lockCapabilities.set(handle, capability);
    descriptor = null;
    return handle;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function releasePlatformRouterLock(
  handle: PlatformRouterLockHandle,
  environment: ResolvedEnvironment,
  syncRoot: boolean,
): void {
  const capability = lockCapabilities.get(handle);
  if (capability === undefined) {
    throw new PlatformRouterLockOwnershipError("AI 配置事务锁能力无效");
  }
  try {
    assertPlatformRouterLockOwned(handle, environment);
  } catch (cause) {
    // A handle that can no longer prove ownership must become terminal. Keeping its pinned
    // directory descriptor open cannot make a later release safe and leaks one FD per incident.
    finishLockCapability(handle, capability);
    throw cause;
  }
  const lockPath = path.join(
    environment.root,
    PLATFORM_ROUTER_LOCK_DIRECTORY,
  );
  const releasedPath = path.join(
    environment.root,
    `.platform-router.tx.lock.released-${capability.nonce}`,
  );
  assertAbsent(releasedPath, "AI 配置事务锁释放路径已存在");

  // This assertion is intentionally adjacent to the ownership-changing rename.
  assertPlatformRouterLockOwned(handle, environment);
  environment.io.rename(lockPath, releasedPath);
  const releasedIsOwned = sameLockDirectory(
    releasedPath,
    capability.device,
    capability.inode,
    environment,
  );
  if (!releasedIsOwned) {
    if (!pathExists(lockPath) && pathExists(releasedPath)) {
      try {
        renameSync(releasedPath, lockPath);
      } catch {
        // Keep every mismatched directory intact and fail closed.
      }
    }
    finishLockCapability(handle, capability);
    throw new PlatformRouterLockOwnershipError(
      "AI 配置事务锁释放路径身份已改变",
    );
  }

  let syncFailure: unknown;
  try {
    if (syncRoot) fsyncDirectory(environment.root, environment);
  } catch (cause) {
    syncFailure = cause;
  }
  try {
    removeLockArtifact(
      releasedPath,
      "released",
      capability,
      environment,
    );
    if (syncRoot) fsyncDirectory(environment.root, environment);
  } catch (cause) {
    if (syncFailure === undefined) syncFailure = cause;
  } finally {
    finishLockCapability(handle, capability);
  }
  if (syncFailure !== undefined) throw syncFailure;
}

function finishLockCapability(
  handle: PlatformRouterLockHandle,
  capability: LockCapability,
): void {
  capability.released = true;
  lockCapabilities.delete(handle);
  closeSync(capability.descriptor);
}

function createLockOwner(environment: ResolvedEnvironment): PlatformRouterLockOwner {
  const bootId = normalizeBootId(environment.readBootId());
  const startTicks = normalizeStartTicks(
    environment.readProcessStartTicks(environment.pid),
  );
  return {
    pid: normalizePid(environment.pid),
    bootId,
    startTicks,
    nonce: normalizeUuid(environment.nextId()),
    acquiredAt: normalizeIsoInstant(environment.now().toISOString()),
  };
}

function inspectLockStaleness(
  lockPath: string,
  creationGraceMs: number,
  environment: ResolvedEnvironment,
): LockInspection | null {
  let descriptor: number;
  try {
    descriptor = environment.io.open(
      lockPath,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
  } catch (cause) {
    if (isNodeErrorCode(cause, "ENOENT")) return null;
    throw new PlatformRouterCorruptionError("AI 配置事务锁路径无效", {
      cause,
    });
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isDirectory()) {
      throw new PlatformRouterCorruptionError("AI 配置事务锁路径无效");
    }
    const ownerState = readLockOwnerState(
      path.join(`/proc/self/fd/${descriptor}`, PLATFORM_ROUTER_LOCK_OWNER_FILE),
      environment,
    );
    if (!sameLockDirectory(lockPath, stat.dev, stat.ino, environment)) {
      closeSync(descriptor);
      return null;
    }
    return {
      descriptor,
      device: stat.dev,
      inode: stat.ino,
      modifiedAtMs: stat.mtimeMs,
      ownerBytes: ownerState?.bytes ?? null,
      owner: ownerState?.owner ?? null,
      stale: isStaleLockOwner(
        ownerState?.owner ?? null,
        stat.mtimeMs,
        creationGraceMs,
        environment,
      ),
    };
  } catch (cause) {
    closeSync(descriptor);
    throw cause;
  }
}

function takeOverStaleLock(
  lockPath: string,
  inspection: LockInspection,
  owner: PlatformRouterLockOwner,
  creationGraceMs: number,
  environment: ResolvedEnvironment,
): PlatformRouterLockHandle | null {
  const identity = inspection.owner?.nonce ?? createHash("sha256")
    .update(`${inspection.device}:${inspection.inode}:`)
    .update(inspection.ownerBytes ?? Buffer.alloc(0))
    .digest("hex");
  const directoryPath = `/proc/self/fd/${inspection.descriptor}`;
  const claimName = `.recovery-claim-${identity}`;
  if (!LOCK_RECOVERY_CLAIM_PATTERN.test(claimName)) {
    throw new PlatformRouterCorruptionError("AI 配置事务锁恢复标记无效");
  }
  const claimPath = path.join(directoryPath, claimName);
  if (!sameLockDirectory(lockPath, inspection.device, inspection.inode, environment)) {
    return null;
  }
  try {
    writeExclusiveFile(
      claimPath,
      Buffer.from(`${JSON.stringify(owner)}\n`),
      0o600,
      environment,
    );
  } catch (cause) {
    if (isNodeErrorCode(cause, "EEXIST") || isNodeErrorCode(cause, "ENOENT")) {
      return null;
    }
    throw cause;
  }

  try {
    environment.io.fsync(inspection.descriptor);
    if (!sameLockDirectory(lockPath, inspection.device, inspection.inode, environment)) {
      return null;
    }
    const current = readLockOwnerState(
      path.join(directoryPath, PLATFORM_ROUTER_LOCK_OWNER_FILE),
      environment,
    );
    if (!sameNullableBuffer(current?.bytes ?? null, inspection.ownerBytes)) {
      return null;
    }
    if (
      !isStaleLockOwner(
        current?.owner ?? null,
        inspection.modifiedAtMs,
        creationGraceMs,
        environment,
      )
    ) {
      return null;
    }
    environment.io.rename(
      claimPath,
      path.join(directoryPath, PLATFORM_ROUTER_LOCK_OWNER_FILE),
    );
    const handle = createLockHandle(owner, environment, {
      device: inspection.device,
      inode: inspection.inode,
    });
    try {
      environment.io.fsync(inspection.descriptor);
    } catch (cause) {
      try {
        releasePlatformRouterLock(handle, environment, false);
      } catch (cleanupCause) {
        try {
          assertPlatformRouterLockOwned(handle, environment);
          const capability = lockCapabilities.get(handle);
          if (capability) capability.publicationUncertain = true;
          return handle;
        } catch (ownershipCause) {
          throw new PlatformRouterTransactionError(
            "AI 配置事务锁接管同步失败且无法安全回滚",
            { cause: new AggregateError([cause, cleanupCause, ownershipCause]) },
          );
        }
      }
      throw cause;
    }
    return handle;
  } finally {
    removeLockFile(claimPath, environment);
  }
}

function isStaleLockOwner(
  owner: PlatformRouterLockOwner | null,
  modifiedAtMs: number,
  creationGraceMs: number,
  environment: ResolvedEnvironment,
): boolean {
  if (owner === null) {
    return environment.nowMs() - modifiedAtMs >= creationGraceMs;
  }
  if (owner.bootId !== normalizeBootId(environment.readBootId())) return true;
  const actualStartTicks = environment.readProcessStartTicks(owner.pid);
  return actualStartTicks === null || actualStartTicks !== owner.startTicks;
}

function sameLockDirectory(
  lockPath: string,
  device: number,
  inode: number,
  environment: ResolvedEnvironment,
): boolean {
  try {
    const stat = environment.io.lstat(lockPath);
    return stat.isDirectory() && !stat.isSymbolicLink() &&
      stat.dev === device && stat.ino === inode;
  } catch (cause) {
    if (isNodeErrorCode(cause, "ENOENT")) return false;
    throw cause;
  }
}

function sameNullableBuffer(left: Buffer | null, right: Buffer | null): boolean {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}

function readLockOwnerState(
  ownerPath: string,
  environment: ResolvedEnvironment,
): { bytes: Buffer; owner: PlatformRouterLockOwner | null } | null {
  const bytes = readRegularFile(ownerPath, true, environment);
  if (bytes === null) return null;
  try {
    return { bytes, owner: decodeLockOwner(parseStrictJson(bytes)) };
  } catch {
    return { bytes, owner: null };
  }
}

function decodeLockOwner(value: unknown): PlatformRouterLockOwner {
  if (
    !isRecord(value) ||
    typeof value.pid !== "number" ||
    typeof value.bootId !== "string" ||
    typeof value.startTicks !== "string" ||
    typeof value.nonce !== "string" ||
    typeof value.acquiredAt !== "string"
  ) {
    throw new PlatformRouterCorruptionError("AI 配置事务锁 owner 损坏");
  }
  return {
    pid: normalizePid(value.pid),
    bootId: normalizeBootId(value.bootId),
    startTicks: normalizeStartTicks(value.startTicks),
    nonce: normalizeUuid(value.nonce),
    acquiredAt: normalizeIsoInstant(value.acquiredAt),
  };
}

function removeLockArtifact(
  target: string,
  kind: "candidate" | "released",
  identity: DirectoryIdentity,
  environment: ResolvedEnvironment,
): boolean {
  const basename = path.basename(target);
  const accepted = kind === "candidate"
    ? LOCK_CANDIDATE_PATTERN.test(basename)
    : LOCK_RELEASED_PATTERN.test(basename);
  if (!accepted) return false;
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = environment.io.lstat(target);
  } catch (cause) {
    if (isNodeErrorCode(cause, "ENOENT")) return false;
    throw cause;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PlatformRouterCorruptionError("AI 配置事务锁清理路径无效");
  }
  if (stat.dev !== identity.device || stat.ino !== identity.inode) return false;
  rmSync(target, { recursive: true, force: false });
  return true;
}

function removeLockFile(
  target: string,
  environment: ResolvedEnvironment,
): void {
  if (!LOCK_RECOVERY_CLAIM_PATTERN.test(path.basename(target))) return;
  try {
    const stat = environment.io.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    environment.io.unlink(target);
  } catch (cause) {
    if (!isNodeErrorCode(cause, "ENOENT")) throw cause;
  }
}

function validateCommitParent(
  generationId: string,
  parentGenerationId: string | null,
  environment: ResolvedEnvironment,
): Buffer | null {
  if (generationId === parentGenerationId) {
    throw new PlatformRouterConflictError("AI 配置代际不能引用自身为父代");
  }
  const pointerPath = path.join(environment.root, PLATFORM_ROUTER_POINTER_FILE);
  const pointerBytes = readRegularFile(pointerPath, true, environment);
  if (pointerBytes === null) {
    if (parentGenerationId !== null) {
      throw new PlatformRouterConflictError("AI 配置初始代际父代必须为空");
    }
    return null;
  }
  let pointer: PlatformRouterPointer;
  try {
    pointer = decodePointer(parseStrictJson(pointerBytes));
  } catch (cause) {
    throw new PlatformRouterCorruptionError("AI 配置当前指针损坏", { cause });
  }
  if (
    parentGenerationId === null ||
    parentGenerationId !== pointer.generationId
  ) {
    throw new PlatformRouterConflictError("AI 配置提交父代已过期");
  }
  const parentPath = generationPathFor(parentGenerationId, environment);
  const parentBytes = readRegularFile(parentPath, false, environment)!;
  const parentHash = createHash("sha256").update(parentBytes).digest("hex");
  if (parentHash !== pointer.sha256) {
    throw new PlatformRouterCorruptionError("AI 配置父代校验失败");
  }
  const parent = decodeGeneration(parseStrictJson(parentBytes));
  if (parent.generationId !== parentGenerationId) {
    throw new PlatformRouterCorruptionError("AI 配置父代身份不匹配");
  }
  return pointerBytes;
}

function assertPointerUnchanged(
  expected: Buffer | null,
  environment: ResolvedEnvironment,
): void {
  const actual = readRegularFile(
    path.join(environment.root, PLATFORM_ROUTER_POINTER_FILE),
    true,
    environment,
  );
  if (!sameNullableBuffer(actual, expected)) {
    throw new PlatformRouterConflictError("AI 配置当前指针在提交期间发生变化");
  }
}

function readLegacySnapshot(environment: ResolvedEnvironment): PlatformRouterSnapshot {
  const activeRaw = readLegacyEntry("platform-router.json", environment);
  const draftRaw = readLegacyEntry("platform-router.draft.json", environment);
  const metadataRaw = readLegacyEntry(
    "platform-router.draft.meta.json",
    environment,
  );
  const attestationRaw = readLegacyEntry(
    "platform-router.draft.test.json",
    environment,
  );
  const active = decodeLegacyConfig(activeRaw, "AI 旧版生效配置损坏");
  const draftConfig = decodeLegacyConfig(draftRaw, "AI 旧版待测配置损坏");
  const metadata = decodeLegacyMetadata(metadataRaw);
  const attestation = decodeLegacyAttestation(attestationRaw);
  if (!draftConfig && (metadataRaw !== null || attestationRaw !== null)) {
    throw new PlatformRouterCorruptionError("AI 旧版待测状态不完整");
  }
  const draft = draftConfig
    ? {
        config: draftConfig,
        metadata: metadata ?? { keyChanged: false },
        attestation,
      }
    : null;
  return {
    source: active || draft ? "legacy" : "empty",
    pointer: null,
    generationId: null,
    parentGenerationId: null,
    committedAt: null,
    active,
    draft,
    pendingAudit: [],
  };
}

function decodeLegacyConfig(
  raw: Buffer | null,
  message: string,
): NormalizedStoredRouterConfig | null {
  if (raw === null) return null;
  const decoded = decodeStoredRouterConfig(raw.toString("utf8").trim());
  if (!decoded) throw new PlatformRouterCorruptionError(message);
  return decoded;
}

function decodeLegacyMetadata(raw: Buffer | null): DraftMetadata | null {
  if (raw === null) return null;
  const value = parseStrictJson(raw);
  if (!isRecord(value) || typeof value.keyChanged !== "boolean") {
    throw new PlatformRouterCorruptionError("AI 旧版待测元数据损坏");
  }
  return { keyChanged: value.keyChanged };
}

function decodeLegacyAttestation(raw: Buffer | null): DraftTestAttestation | null {
  if (raw === null) return null;
  const value = parseStrictJson(raw);
  if (
    !isRecord(value) ||
    typeof value.digest !== "string" ||
    !SHA256_PATTERN.test(value.digest) ||
    typeof value.testedAt !== "string" ||
    typeof value.requestId !== "string" ||
    !value.requestId ||
    /[\r\n]/.test(value.requestId)
  ) {
    throw new PlatformRouterCorruptionError("AI 旧版待测凭据损坏");
  }
  return {
    digest: value.digest,
    testedAt: normalizeIsoInstant(value.testedAt),
    requestId: boundedAuditText(value.requestId, "request id"),
  };
}

function readLegacyEntry(
  filename: string,
  environment: ResolvedEnvironment,
): Buffer | null {
  return readRegularFile(path.join(environment.root, filename), true, environment);
}

function decodePointer(value: unknown): PlatformRouterPointer {
  if (
    !isRecord(value) ||
    value.schemaVersion !== POINTER_SCHEMA_VERSION ||
    typeof value.generationId !== "string" ||
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256)
  ) {
    throw new PlatformRouterValidationError("AI 配置指针格式无效");
  }
  return {
    schemaVersion: POINTER_SCHEMA_VERSION,
    generationId: normalizeUuid(value.generationId),
    sha256: value.sha256,
  };
}

function decodeGeneration(value: unknown): PlatformRouterGeneration {
  if (
    !isRecord(value) ||
    value.schemaVersion !== GENERATION_SCHEMA_VERSION ||
    typeof value.generationId !== "string" ||
    !(value.parentGenerationId === null || typeof value.parentGenerationId === "string") ||
    typeof value.committedAt !== "string" ||
    !Array.isArray(value.pendingAudit)
  ) {
    throw new PlatformRouterValidationError("AI 配置代际格式无效");
  }
  const active = decodeGenerationConfig(value.active);
  const draft = decodeGenerationDraft(value.draft);
  if (value.pendingAudit.length > MAX_PENDING_AUDIT_RECORDS) {
    throw new PlatformRouterValidationError("AI 配置待投影审计事件过多");
  }
  const pendingAudit = value.pendingAudit.map((record) =>
    decodePlatformRouterAuditRecord(record),
  );
  const eventIds = new Set<string>();
  for (const record of pendingAudit) {
    if (eventIds.has(record.eventId)) {
      throw new PlatformRouterValidationError("AI 配置待投影审计事件重复");
    }
    eventIds.add(record.eventId);
  }
  return {
    schemaVersion: GENERATION_SCHEMA_VERSION,
    generationId: normalizeUuid(value.generationId),
    parentGenerationId:
      value.parentGenerationId === null
        ? null
        : normalizeUuid(value.parentGenerationId),
    committedAt: normalizeIsoInstant(value.committedAt),
    active,
    draft,
    pendingAudit,
  };
}

function decodeGenerationConfig(value: unknown): NormalizedStoredRouterConfig | null {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new PlatformRouterValidationError("AI 配置代际配置无效");
  }
  return normalizeStoredRouterConfig({
    endpoint: value.endpoint,
    model: value.model,
    protocol: value.protocol,
    enabled: value.enabled,
    credentialFile: value.credentialFile,
    assistantInstructions: value.assistantInstructions,
    assistantMaxOutputTokens: value.assistantMaxOutputTokens,
    assistantTemperature: value.assistantTemperature,
    assistantMaxSteps: value.assistantMaxSteps,
    assistantTimeoutMs: value.assistantTimeoutMs,
    assistantReasoningEffort: value.assistantReasoningEffort,
    modelReasoningEfforts: value.modelReasoningEfforts,
  });
}

function decodeGenerationDraft(value: unknown): StoredRouterDraft | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !isRecord(value.metadata) ||
    typeof value.metadata.keyChanged !== "boolean"
  ) {
    throw new PlatformRouterValidationError("AI 配置代际待测状态无效");
  }
  const config = decodeGenerationConfig(value.config);
  if (!config) throw new PlatformRouterValidationError("AI 配置代际待测配置无效");
  let attestation: DraftTestAttestation | null = null;
  if (value.attestation !== null) {
    if (
      !isRecord(value.attestation) ||
      typeof value.attestation.digest !== "string" ||
      !SHA256_PATTERN.test(value.attestation.digest) ||
      typeof value.attestation.testedAt !== "string" ||
      typeof value.attestation.requestId !== "string" ||
      !value.attestation.requestId ||
      /[\r\n]/.test(value.attestation.requestId)
    ) {
      throw new PlatformRouterValidationError("AI 配置代际测试凭据无效");
    }
    attestation = {
      digest: value.attestation.digest,
      testedAt: normalizeIsoInstant(value.attestation.testedAt),
      requestId: boundedAuditText(
        value.attestation.requestId,
        "request id",
      ),
    };
  }
  return {
    config,
    metadata: { keyChanged: value.metadata.keyChanged },
    attestation,
  };
}

function snapshotFromGeneration(
  generation: PlatformRouterGeneration,
  pointer: PlatformRouterPointer,
): PlatformRouterSnapshot {
  return {
    source: "generation",
    pointer,
    generationId: generation.generationId,
    parentGenerationId: generation.parentGenerationId,
    committedAt: generation.committedAt,
    active: generation.active,
    draft: generation.draft,
    pendingAudit: generation.pendingAudit,
  };
}

function scanAndRepairAuditJournal(
  auditPath: string,
  wantedEventIds: ReadonlySet<string>,
  environment: ResolvedEnvironment,
): { records: Map<string, PlatformRouterAuditRecord>; repairedTail: boolean } {
  if (!pathExists(auditPath)) return { records: new Map(), repairedTail: false };
  assertRegularPathIfPresent(auditPath, "AI 配置审计路径无效");
  let descriptor: number | null = null;
  try {
    descriptor = environment.io.open(
      auditPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    if (!fstatSync(descriptor).isFile()) {
      throw new PlatformRouterCorruptionError("AI 配置审计路径无效");
    }
    const records = new Map<string, PlatformRouterAuditRecord>();
    const chunk = Buffer.allocUnsafe(AUDIT_SCAN_CHUNK_BYTES);
    let carry = Buffer.alloc(0);
    for (;;) {
      const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      const available = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      let lineStart = 0;
      for (;;) {
        const newline = available.indexOf(0x0a, lineStart);
        if (newline < 0) break;
        const line = available.subarray(lineStart, newline);
        decodeAuditJournalLine(line, wantedEventIds, records);
        lineStart = newline + 1;
      }
      carry = Buffer.from(available.subarray(lineStart));
      if (carry.length > MAX_AUDIT_RECORD_BYTES) {
        throw new PlatformRouterCorruptionError(
          "AI 配置审计单条记录过大",
        );
      }
    }

    if (carry.length > 0) {
      try {
        // Streaming fatal decode accepts only a valid UTF-8 prefix. It keeps a
        // genuinely truncated final multibyte sequence buffered, while
        // rejecting impossible bytes such as 0xff immediately.
        new TextDecoder("utf-8", { fatal: true }).decode(carry, {
          stream: true,
        });
      } catch (cause) {
        throw new PlatformRouterCorruptionError(
          "AI 配置审计尾部包含无效 UTF-8",
          { cause },
        );
      }
      throw new PlatformRouterAuditPendingError(
        "AI 配置审计存在未完成的尾部记录，稍后重试",
      );
    }
    return { records, repairedTail: false };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function decodeAuditJournalLine(
  line: Buffer,
  wantedEventIds: ReadonlySet<string>,
  records: Map<string, PlatformRouterAuditRecord>,
): void {
  if (line.length === 0 || line.length > MAX_AUDIT_RECORD_BYTES) {
    throw new PlatformRouterCorruptionError(
      line.length > MAX_AUDIT_RECORD_BYTES
        ? "AI 配置审计单条记录过大"
        : "AI 配置审计包含完整的无效记录",
    );
  }
  let record: PlatformRouterAuditRecord;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
    record = decodePlatformRouterAuditRecord(JSON.parse(text));
  } catch (cause) {
    throw new PlatformRouterCorruptionError(
      "AI 配置审计包含完整的无效记录",
      { cause },
    );
  }
  if (!wantedEventIds.has(record.eventId)) return;
  const existing = records.get(record.eventId);
  if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
    throw new PlatformRouterCorruptionError("AI 配置审计事件 ID 内容冲突");
  }
  records.set(record.eventId, record);
}

function readGenerationWithoutPointer(
  generationId: string,
  environment: ResolvedEnvironment,
): PlatformRouterGeneration {
  const bytes = readRegularFile(
    generationPathFor(generationId, environment),
    false,
    environment,
  )!;
  let generation: PlatformRouterGeneration;
  try {
    generation = decodeGeneration(parseStrictJson(bytes));
  } catch (cause) {
    throw new PlatformRouterCorruptionError("AI 配置保留代际损坏", {
      cause,
    });
  }
  if (generation.generationId !== generationId) {
    throw new PlatformRouterCorruptionError("AI 配置保留代际身份不匹配");
  }
  return generation;
}

function markGenerationCredentials(
  generation: PlatformRouterGeneration,
  output: Set<string>,
): void {
  if (generation.active) output.add(generation.active.credentialFile);
  if (generation.draft) output.add(generation.draft.config.credentialFile);
}

function markSnapshotCredentials(
  snapshot: Pick<PlatformRouterSnapshot, "active" | "draft">,
  output: Set<string>,
): void {
  if (snapshot.active) output.add(snapshot.active.credentialFile);
  if (snapshot.draft) output.add(snapshot.draft.config.credentialFile);
}

function ensureGenerationDirectory(environment: ResolvedEnvironment): string {
  const directory = path.join(
    environment.root,
    PLATFORM_ROUTER_GENERATION_DIRECTORY,
  );
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new PlatformRouterCorruptionError("AI 配置代际目录无效");
    }
  } catch (cause) {
    if (!isNodeErrorCode(cause, "ENOENT")) throw cause;
    mkdirSync(directory, { mode: 0o750 });
    chmodSync(directory, 0o750);
    fsyncDirectory(environment.root, environment);
  }
  return directory;
}

function generationPathFor(
  generationId: string,
  environment: ResolvedEnvironment,
): string {
  const normalized = normalizeUuid(generationId);
  return path.join(
    environment.root,
    PLATFORM_ROUTER_GENERATION_DIRECTORY,
    `${normalized}.json`,
  );
}

function writeExclusiveFile(
  target: string,
  bytes: Buffer,
  mode: number,
  environment: ResolvedEnvironment,
): void {
  let descriptor: number | null = null;
  try {
    descriptor = environment.io.open(
      target,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        fsConstants.O_NOFOLLOW,
      mode,
    );
    if (!fstatSync(descriptor).isFile()) {
      throw new PlatformRouterCorruptionError("AI 配置事务目标不是普通文件");
    }
    fchmodSync(descriptor, mode);
    writeAll(descriptor, bytes, environment);
    environment.io.fsync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function writeAll(
  descriptor: number,
  bytes: Buffer,
  environment: ResolvedEnvironment,
): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = environment.io.write(
      descriptor,
      bytes,
      offset,
      bytes.length - offset,
      null,
    );
    if (written <= 0) {
      throw new PlatformRouterTransactionError("AI 配置事务写入返回零字节");
    }
    offset += written;
  }
}

function readRegularFile(
  target: string,
  optional: boolean,
  environment: ResolvedEnvironment,
): Buffer | null {
  let descriptor: number | null = null;
  try {
    assertRegularPathIfPresent(target, "AI 配置事务路径无效");
    descriptor = environment.io.open(
      target,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES) {
      throw new PlatformRouterCorruptionError("AI 配置事务文件无效");
    }
    return readFileSync(/* turbopackIgnore: true */ descriptor);
  } catch (cause) {
    if (optional && isNodeErrorCode(cause, "ENOENT")) return null;
    if (cause instanceof PlatformRouterTransactionError) throw cause;
    throw new PlatformRouterCorruptionError("AI 配置事务文件无法读取", {
      cause,
    });
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function parseStrictJson(bytes: Buffer): ParsedJson {
  const raw = bytes.toString("utf8").trim();
  if (!raw) throw new Error("empty JSON");
  try {
    return JSON.parse(raw) as ParsedJson;
  } catch (cause) {
    throw new Error("malformed JSON", { cause });
  }
}

function assertRegularPathIfPresent(target: string, message: string): void {
  try {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new PlatformRouterCorruptionError(message);
    }
  } catch (cause) {
    if (!isNodeErrorCode(cause, "ENOENT")) throw cause;
  }
}

function assertTrustedDirectory(directory: string, message: string): void {
  let stat;
  try {
    stat = lstatSync(directory);
  } catch (cause) {
    throw new PlatformRouterTransactionError(message, { cause });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PlatformRouterCorruptionError(message);
  }
}

function assertAbsent(target: string, message: string): void {
  try {
    lstatSync(target);
    throw new PlatformRouterConflictError(message);
  } catch (cause) {
    if (isNodeErrorCode(cause, "ENOENT")) return;
    throw cause;
  }
}

function fsyncDirectory(
  directory: string,
  environment: ResolvedEnvironment,
): void {
  const descriptor = environment.io.open(
    directory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    environment.io.fsync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function removeRecognizedTemporary(
  target: string,
  environment: ResolvedEnvironment,
): void {
  const basename = path.basename(target);
  const recognized =
    POINTER_TEMP_PATTERN.test(basename) ||
    GENERATION_TEMP_PATTERN.test(basename);
  if (!recognized) return;
  try {
    assertRegularPathIfPresent(target, "AI 配置临时路径无效");
    environment.io.unlink(target);
    fsyncDirectory(path.dirname(target), environment);
  } catch (cause) {
    if (!isNodeErrorCode(cause, "ENOENT")) {
      // Recovery performs a second, lock-scoped cleanup; never mask commit state.
    }
  }
}

function normalizeUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new PlatformRouterValidationError("AI 配置事务 ID 无效");
  }
  return value.toLowerCase();
}

function normalizeCredentialName(value: string): string {
  if (value === LEGACY_ROUTER_KEY_FILE || MANAGED_ROUTER_KEY_FILE.test(value)) {
    return value;
  }
  throw new PlatformRouterValidationError("AI 配置凭据文件引用无效");
}

function normalizeBootId(value: unknown): string {
  if (typeof value !== "string" || !BOOT_ID_PATTERN.test(value.trim())) {
    throw new PlatformRouterValidationError("AI 配置事务 boot ID 无效");
  }
  return value.trim().toLowerCase();
}

function normalizeStartTicks(value: unknown): string {
  if (typeof value !== "string" || !START_TICKS_PATTERN.test(value)) {
    throw new PlatformRouterValidationError("AI 配置事务进程起始时间无效");
  }
  return value;
}

function normalizePid(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new PlatformRouterValidationError("AI 配置事务 PID 无效");
  }
  return value;
}

function normalizeIsoInstant(value: unknown): string {
  if (typeof value !== "string") {
    throw new PlatformRouterValidationError("AI 配置事务时间无效");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new PlatformRouterValidationError("AI 配置事务时间无效");
  }
  return value;
}

function boundedDuration(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function resolveHandleEnvironment(
  handle: PlatformRouterLockHandle,
  options: PlatformRouterTransactionOptions,
): ResolvedEnvironment {
  if (options.root !== undefined && path.resolve(options.root) !== handle.root) {
    throw new PlatformRouterLockOwnershipError(
      "AI 配置事务锁根目录与事务目标不匹配",
    );
  }
  return resolveEnvironment({ ...options, root: handle.root });
}

function resolveEnvironment(
  options: PlatformRouterTransactionOptions,
): ResolvedEnvironment {
  return {
    root: path.resolve(options.root ?? PLATFORM_ROUTER_SECRET_ROOT),
    now: options.now ?? (() => new Date()),
    nowMs: options.nowMs ?? Date.now,
    monotonicNowMs: options.monotonicNowMs ?? (() => performance.now()),
    nextId: options.nextId ?? randomUUID,
    random: options.random ?? Math.random,
    sleep:
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds))),
    pid: options.pid ?? process.pid,
    readBootId: options.readBootId ?? defaultReadBootId,
    readProcessStartTicks:
      options.readProcessStartTicks ?? defaultReadProcessStartTicks,
    beforeStaleTakeover: options.beforeStaleTakeover ?? (() => undefined),
    io: {
      open: options.io?.open ?? openSync,
      write: options.io?.write ?? writeSync,
      fsync: options.io?.fsync ?? fsyncSync,
      ftruncate: options.io?.ftruncate ?? ftruncateSync,
      lstat: options.io?.lstat ?? lstatSync,
      rename: options.io?.rename ?? renameSync,
      unlink: options.io?.unlink ?? unlinkSync,
    },
  };
}

function defaultReadBootId(): string {
  return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}

function defaultReadProcessStartTicks(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${normalizePid(pid)}/stat`, "utf8");
    const closingParenthesis = stat.lastIndexOf(")");
    if (closingParenthesis < 0) return null;
    const fieldsAfterCommand = stat
      .slice(closingParenthesis + 1)
      .trim()
      .split(/\s+/);
    const startTicks = fieldsAfterCommand[19];
    return startTicks && START_TICKS_PATTERN.test(startTicks)
      ? startTicks
      : null;
  } catch (cause) {
    if (isNodeErrorCode(cause, "ENOENT") || isNodeErrorCode(cause, "ESRCH")) {
      return null;
    }
    throw cause;
  }
}

function pathExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch (cause) {
    if (isNodeErrorCode(cause, "ENOENT")) return false;
    throw cause;
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

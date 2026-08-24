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
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
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
const MAX_STATE_BYTES = 1024 * 1024;
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

export interface PlatformRouterPointer {
  schemaVersion: 1;
  generationId: string;
  sha256: string;
}

export interface PlatformRouterGeneration {
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

export interface PlatformRouterLockOwner {
  pid: number;
  bootId: string;
  startTicks: string;
  nonce: string;
  acquiredAt: string;
}

export interface PlatformRouterLockHandle {
  readonly owner: PlatformRouterLockOwner;
  readonly root: string;
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
  nextId?: () => string;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  pid?: number;
  readBootId?: () => string;
  readProcessStartTicks?: (pid: number) => string | null;
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
  nextId: () => string;
  random: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  pid: number;
  readBootId: () => string;
  readProcessStartTicks: (pid: number) => string | null;
  io: Required<PlatformRouterIoOverrides>;
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
  const startedAt = environment.nowMs();
  const lockPath = path.join(environment.root, PLATFORM_ROUTER_LOCK_DIRECTORY);

  for (;;) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      chmodSync(lockPath, 0o700);
      const owner = createLockOwner(environment);
      try {
        writeExclusiveFile(
          path.join(lockPath, PLATFORM_ROUTER_LOCK_OWNER_FILE),
          Buffer.from(`${JSON.stringify(owner)}\n`),
          0o600,
          environment,
        );
        fsyncDirectory(lockPath, environment);
        fsyncDirectory(environment.root, environment);
      } catch (cause) {
        quarantineAndRemoveOwnedLock(lockPath, environment);
        throw cause;
      }
      return createLockHandle(owner, environment);
    } catch (cause) {
      if (!isNodeErrorCode(cause, "EEXIST")) {
        if (cause instanceof PlatformRouterTransactionError) throw cause;
        throw new PlatformRouterTransactionError("AI 配置事务锁无法创建", {
          cause,
        });
      }
    }

    const stale = inspectLockStaleness(
      lockPath,
      creationGraceMs,
      environment,
    );
    if (stale) {
      const recovered = quarantineStaleLock(lockPath, environment);
      if (recovered) continue;
    }

    const elapsed = environment.nowMs() - startedAt;
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
  options: PlatformRouterTransactionOptions = {},
): PlatformRouterSnapshot {
  const environment = resolveEnvironment(options);
  assertTrustedDirectory(environment.root, "AI 事务根目录无效");
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
  const pointer: PlatformRouterPointer = {
    schemaVersion: POINTER_SCHEMA_VERSION,
    generationId,
    sha256: createHash("sha256").update(generationBytes).digest("hex"),
  };
  const pointerBytes = Buffer.from(`${JSON.stringify(pointer)}\n`);
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
    writeExclusiveFile(generationTemporary, generationBytes, 0o640, environment);
    environment.io.rename(generationTemporary, generationPath);
    fsyncDirectory(generationDirectory, environment);

    assertRegularPathIfPresent(pointerPath, "AI 配置当前指针路径无效");
    writeExclusiveFile(pointerTemporary, pointerBytes, 0o640, environment);
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
    removeRecognizedTemporary(generationTemporary, environment);
    removeRecognizedTemporary(pointerTemporary, environment);
    if (pointerRenamed || cause instanceof PlatformRouterCommitUncertainError) {
      throw cause;
    }
    if (cause instanceof PlatformRouterTransactionError) throw cause;
    throw new PlatformRouterTransactionError("AI 配置代际提交失败", { cause });
  }
}

export function flushAuditOutbox(
  snapshot: PlatformRouterSnapshot,
  options: PlatformRouterTransactionOptions = {},
): PlatformRouterAuditFlushResult {
  const environment = resolveEnvironment(options);
  assertTrustedDirectory(environment.root, "AI 事务根目录无效");
  const auditPath = path.join(environment.root, PLATFORM_ROUTER_AUDIT_FILE);
  const scan = scanAndRepairAuditJournal(auditPath, environment);
  const pending = snapshot.pendingAudit.map((record) =>
    decodePlatformRouterAuditRecord(record),
  );
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
      fchmodSync(descriptor, 0o640);
      for (const record of missing) {
        writeAll(
          descriptor,
          Buffer.from(`${JSON.stringify(record)}\n`),
          environment,
        );
        appendedEventIds.push(record.eventId);
      }
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
  options: PlatformRouterTransactionOptions = {},
): PlatformRouterSnapshot {
  if (snapshot.source !== "generation" || snapshot.generationId === null) {
    throw new PlatformRouterConflictError(
      "AI 配置审计检查点要求已提交代际",
    );
  }
  const current = readCurrentSnapshot(options);
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
  if (remaining.length === current.pendingAudit.length) return current;
  return commitGeneration(
    {
      parentGenerationId: current.generationId,
      active: current.active,
      draft: current.draft,
      pendingAudit: remaining,
    },
    options,
  );
}

export async function recoverPlatformRouterTransactions(
  options: PlatformRouterTransactionOptions = {},
): Promise<PlatformRouterRecoveryResult> {
  return withPlatformRouterLock(async () => {
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
        options,
      );
    }

    const audit = flushAuditOutbox(snapshot, options);
    snapshot = checkpointDeliveredAudit(
      snapshot,
      audit.deliveredEventIds,
      options,
    );
    validateReferencedCredentials(snapshot, options);
    cleanupRecognizedOrphanTemps(options);
    const garbageCollection = garbageCollectPlatformRouterArtifacts(options);
    return { importedLegacy, snapshot, audit, garbageCollection };
  }, options);
}

export function garbageCollectPlatformRouterArtifacts(
  options: PlatformRouterTransactionOptions = {},
): PlatformRouterGarbageCollectionResult {
  const environment = resolveEnvironment(options);
  const current = readCurrentSnapshot(options);
  if (current.source !== "generation" || current.generationId === null) {
    throw new PlatformRouterConflictError("AI 配置垃圾回收要求已提交代际");
  }
  const generationDirectory = ensureGenerationDirectory(environment);
  const graceCutoff = environment.nowMs() - boundedDuration(
    options.gcGraceMs,
    DEFAULT_GC_GRACE_MS,
    0,
    7 * 24 * 60 * 60_000,
  );
  const retained = new Set<string>();
  const retainedGenerations = new Map<string, PlatformRouterGeneration>();
  let nextGenerationId: string | null = current.generationId;

  for (let depth = 0; depth < 3 && nextGenerationId; depth += 1) {
    const generation = readGenerationWithoutPointer(nextGenerationId, environment);
    retained.add(generation.generationId);
    retainedGenerations.set(generation.generationId, generation);
    nextGenerationId = generation.parentGenerationId;
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
      retainedGenerations.set(generationId, generation);
    }
  }

  const referencedCredentials = new Set<string>();
  for (const generation of retainedGenerations.values()) {
    markGenerationCredentials(generation, referencedCredentials);
  }
  const legacy = readLegacySnapshot(environment);
  markSnapshotCredentials(legacy, referencedCredentials);
  referencedCredentials.add(LEGACY_ROUTER_KEY_FILE);

  const removedGenerations: string[] = [];
  for (const entry of generationEntries) {
    const match = GENERATION_FILE_PATTERN.exec(entry);
    if (!match) continue;
    const generationId = normalizeUuid(match[1]);
    if (retained.has(generationId)) continue;
    const candidate = path.join(generationDirectory, entry);
    assertRegularPathIfPresent(candidate, "AI 配置代际路径无效");
    environment.io.unlink(candidate);
    removedGenerations.push(generationId);
  }
  if (removedGenerations.length > 0) fsyncDirectory(generationDirectory, environment);

  const removedCredentials: string[] = [];
  for (const entry of readdirSync(environment.root)) {
    if (!MANAGED_ROUTER_KEY_FILE.test(entry) || referencedCredentials.has(entry)) {
      continue;
    }
    const candidate = path.join(environment.root, entry);
    const stat = lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new PlatformRouterCorruptionError("AI 配置凭据路径无效");
    }
    if (stat.mtimeMs >= graceCutoff) continue;
    environment.io.unlink(candidate);
    removedCredentials.push(entry);
  }
  if (removedCredentials.length > 0) fsyncDirectory(environment.root, environment);

  return {
    retainedGenerations: [...retained].sort(),
    removedGenerations: removedGenerations.sort(),
    removedCredentials: removedCredentials.sort(),
  };
}

export function cleanupRecognizedOrphanTemps(
  options: PlatformRouterTransactionOptions = {},
): string[] {
  const environment = resolveEnvironment(options);
  const removed: string[] = [];
  for (const entry of readdirSync(environment.root)) {
    if (!POINTER_TEMP_PATTERN.test(entry)) continue;
    const target = path.join(environment.root, entry);
    assertRegularPathIfPresent(target, "AI 配置临时指针路径无效");
    environment.io.unlink(target);
    removed.push(entry);
  }
  const generationDirectory = ensureGenerationDirectory(environment);
  for (const entry of readdirSync(generationDirectory)) {
    if (!GENERATION_TEMP_PATTERN.test(entry)) continue;
    const target = path.join(generationDirectory, entry);
    assertRegularPathIfPresent(target, "AI 配置临时代际路径无效");
    environment.io.unlink(target);
    removed.push(`${PLATFORM_ROUTER_GENERATION_DIRECTORY}/${entry}`);
  }
  if (removed.some((entry) => !entry.includes("/"))) {
    fsyncDirectory(environment.root, environment);
  }
  if (removed.some((entry) => entry.includes("/"))) {
    fsyncDirectory(generationDirectory, environment);
  }
  return removed.sort();
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
    const credentialPath = path.join(environment.root, normalized);
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

function createLockHandle(
  owner: PlatformRouterLockOwner,
  environment: ResolvedEnvironment,
): PlatformRouterLockHandle {
  let released = false;
  return {
    owner,
    root: environment.root,
    release() {
      if (released) return;
      const lockPath = path.join(
        environment.root,
        PLATFORM_ROUTER_LOCK_DIRECTORY,
      );
      const ownerPath = path.join(lockPath, PLATFORM_ROUTER_LOCK_OWNER_FILE);
      let actual: PlatformRouterLockOwner;
      try {
        actual = readLockOwner(ownerPath, environment);
      } catch (cause) {
        throw new PlatformRouterLockOwnershipError(
          "AI 配置事务锁所有权无法确认",
          { cause },
        );
      }
      if (actual.nonce !== owner.nonce) {
        throw new PlatformRouterLockOwnershipError(
          "AI 配置事务锁已由其他进程持有",
        );
      }
      environment.io.unlink(ownerPath);
      fsyncDirectory(lockPath, environment);
      rmdirSync(lockPath);
      fsyncDirectory(environment.root, environment);
      released = true;
    },
  };
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
): boolean {
  const stat = lstatSync(lockPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PlatformRouterCorruptionError("AI 配置事务锁路径无效");
  }
  const ownerPath = path.join(lockPath, PLATFORM_ROUTER_LOCK_OWNER_FILE);
  let owner: PlatformRouterLockOwner;
  try {
    owner = readLockOwner(ownerPath, environment);
  } catch (cause) {
    if (
      isNodeErrorCode(cause, "ENOENT") ||
      cause instanceof PlatformRouterCorruptionError
    ) {
      return environment.nowMs() - stat.mtimeMs >= creationGraceMs;
    }
    throw cause;
  }
  if (owner.bootId !== normalizeBootId(environment.readBootId())) return true;
  const actualStartTicks = environment.readProcessStartTicks(owner.pid);
  return actualStartTicks === null || actualStartTicks !== owner.startTicks;
}

function readLockOwner(
  ownerPath: string,
  environment: ResolvedEnvironment,
): PlatformRouterLockOwner {
  const bytes = readRegularFile(ownerPath, false, environment)!;
  let value: unknown;
  try {
    value = parseStrictJson(bytes);
  } catch (cause) {
    throw new PlatformRouterCorruptionError("AI 配置事务锁 owner 损坏", {
      cause,
    });
  }
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

function quarantineStaleLock(
  lockPath: string,
  environment: ResolvedEnvironment,
): boolean {
  const quarantine = path.join(
    environment.root,
    `${PLATFORM_ROUTER_LOCK_DIRECTORY}.quarantine-${normalizeUuid(environment.nextId())}`,
  );
  try {
    environment.io.rename(lockPath, quarantine);
  } catch (cause) {
    if (isNodeErrorCode(cause, "ENOENT")) return false;
    throw new PlatformRouterTransactionError("AI 配置陈旧事务锁无法隔离", {
      cause,
    });
  }
  fsyncDirectory(environment.root, environment);
  const stat = lstatSync(quarantine);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PlatformRouterCorruptionError("AI 配置隔离锁路径无效");
  }
  rmSync(quarantine, { recursive: true, force: false });
  fsyncDirectory(environment.root, environment);
  return true;
}

function quarantineAndRemoveOwnedLock(
  lockPath: string,
  environment: ResolvedEnvironment,
): void {
  if (!pathExists(lockPath)) return;
  try {
    quarantineStaleLock(lockPath, environment);
  } catch {
    // Do not mask the acquisition failure. A later contender applies stale recovery.
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
    requestId: value.requestId,
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
      requestId: value.attestation.requestId,
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
  environment: ResolvedEnvironment,
): { records: Map<string, PlatformRouterAuditRecord>; repairedTail: boolean } {
  if (!pathExists(auditPath)) return { records: new Map(), repairedTail: false };
  assertRegularPathIfPresent(auditPath, "AI 配置审计路径无效");
  let descriptor: number | null = null;
  try {
    descriptor = environment.io.open(
      auditPath,
      fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
    );
    if (!fstatSync(descriptor).isFile()) {
      throw new PlatformRouterCorruptionError("AI 配置审计路径无效");
    }
    const bytes = readFileSync(descriptor);
    if (bytes.length > MAX_STATE_BYTES) {
      throw new PlatformRouterCorruptionError("AI 配置审计文件过大");
    }
    const lastNewline = bytes.lastIndexOf(0x0a);
    const completeLength =
      bytes.length === 0 || lastNewline === bytes.length - 1
        ? bytes.length
        : lastNewline + 1;
    const repairedTail = completeLength !== bytes.length;
    if (repairedTail) {
      environment.io.ftruncate(descriptor, completeLength);
      environment.io.fsync(descriptor);
    }
    const records = new Map<string, PlatformRouterAuditRecord>();
    const complete = bytes.subarray(0, completeLength).toString("utf8");
    for (const line of complete.split("\n")) {
      if (!line) continue;
      let record: PlatformRouterAuditRecord;
      try {
        record = decodePlatformRouterAuditRecord(JSON.parse(line));
      } catch (cause) {
        throw new PlatformRouterCorruptionError(
          "AI 配置审计包含完整的无效记录",
          { cause },
        );
      }
      const existing = records.get(record.eventId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new PlatformRouterCorruptionError("AI 配置审计事件 ID 内容冲突");
      }
      records.set(record.eventId, record);
    }
    return { records, repairedTail };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
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
    return readFileSync(descriptor);
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

function resolveEnvironment(
  options: PlatformRouterTransactionOptions,
): ResolvedEnvironment {
  return {
    root: options.root ?? PLATFORM_ROUTER_SECRET_ROOT,
    now: options.now ?? (() => new Date()),
    nowMs: options.nowMs ?? Date.now,
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
    io: {
      open: options.io?.open ?? openSync,
      write: options.io?.write ?? writeSync,
      fsync: options.io?.fsync ?? fsyncSync,
      ftruncate: options.io?.ftruncate ?? ftruncateSync,
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

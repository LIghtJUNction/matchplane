import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { buildPlatformRouterAuditRecord } from "./audit";
import {
  boundedAuditText,
  LEGACY_ROUTER_KEY_FILE,
  type DraftTestAttestation,
  type ManagedPlatformRouterConfig,
  type ManagedPlatformRouterDraftConfig,
  type ManagedPlatformRouterInput,
  type ManagedPlatformRouterSecretConfig,
  type NormalizedStoredRouterConfig,
  normalizeManagedRouterInput,
  normalizeStoredRouterConfig,
  PlatformRouterConfigValidationError,
  presentManagedConfig,
  type StoredRouterDraft,
} from "./contract";
import {
  createProtectedPlatformRouterStorage,
  credentialStorageEntry,
  PLATFORM_ROUTER_SECRET_ROOT,
  ProtectedStorageCommitUncertainError,
  type ProtectedPlatformRouterStorage,
} from "./protected-storage";
import {
  checkpointDeliveredAudit,
  commitGeneration,
  flushAuditOutbox,
  garbageCollectPlatformRouterArtifacts,
  PlatformRouterCommitUncertainError,
  PlatformRouterConflictError,
  PlatformRouterTransactionError,
  readCurrentSnapshot,
  recoverPlatformRouterTransactions,
  validateReferencedCredentials,
  withPlatformRouterLock,
  type PlatformRouterLockHandle,
  type PlatformRouterSnapshot,
  type PlatformRouterTransactionOptions,
} from "./transaction";

export interface PlatformRouterMutationContext {
  actor: string;
  requestId: string;
}

export interface PlatformRouterMarkTestedInput
  extends PlatformRouterMutationContext {
  expectedGenerationId: string;
  expectedDraftDigest: string;
  status?: "ready";
}

export interface PlatformRouterDraftProbe {
  draft: ManagedPlatformRouterDraftConfig;
  secret: ManagedPlatformRouterSecretConfig;
  expectedGenerationId: string;
  expectedDraftDigest: string;
}

export interface PlatformRouterMutationResult<T> {
  value: T;
  state: TransactionalManagedPlatformRouterPublicState;
  committed: true;
  auditPending: boolean;
  maintenancePending: boolean;
  generationId: string;
}

export interface TransactionalManagedPlatformRouterPublicState {
  config: ManagedPlatformRouterConfig | null;
  draft: ManagedPlatformRouterDraftConfig | null;
}

export interface TransactionalManagedPlatformRouterLifecycle {
  readActive(): ManagedPlatformRouterSecretConfig | null;
  readDraft(): ManagedPlatformRouterSecretConfig | null;
  getState(): TransactionalManagedPlatformRouterPublicState;
  getActive(): ManagedPlatformRouterConfig | null;
  getDraft(): ManagedPlatformRouterDraftConfig | null;
  prepareDraftProbe(): PlatformRouterDraftProbe;
  stage(
    input: ManagedPlatformRouterInput,
    context: PlatformRouterMutationContext,
  ): Promise<PlatformRouterMutationResult<ManagedPlatformRouterDraftConfig>>;
  markTested(
    input: PlatformRouterMarkTestedInput,
  ): Promise<PlatformRouterMutationResult<ManagedPlatformRouterDraftConfig>>;
  activate(
    context: PlatformRouterMutationContext,
  ): Promise<PlatformRouterMutationResult<ManagedPlatformRouterConfig>>;
}

export interface TransactionalLifecycleDependencies {
  storage?: ProtectedPlatformRouterStorage;
  transactionOptions?: PlatformRouterTransactionOptions;
  nextId?: () => string;
  now?: () => Date;
}

export class PlatformRouterStorageUncertainError extends PlatformRouterTransactionError {}
export class PlatformRouterStateIndeterminateError extends PlatformRouterTransactionError {}

export function createTransactionalManagedPlatformRouterLifecycle(
  dependencies: TransactionalLifecycleDependencies = {},
): TransactionalManagedPlatformRouterLifecycle {
  const transactionOptions = dependencies.transactionOptions ?? {};
  const root = transactionOptions.root ?? PLATFORM_ROUTER_SECRET_ROOT;
  const storage =
    dependencies.storage ?? createProtectedPlatformRouterStorage(root);
  const nextId = dependencies.nextId ?? randomUUID;
  const now = dependencies.now ?? (() => new Date());

  function readValidatedSnapshot(): PlatformRouterSnapshot {
    try {
      lstatSync(root);
    } catch (cause) {
      if (isNodeErrorCode(cause, "ENOENT")) {
        return emptySnapshot();
      }
      throw cause;
    }
    const snapshot = readCurrentSnapshot(transactionOptions);
    validateReferencedCredentials(snapshot, transactionOptions);
    return snapshot;
  }

  function readSecret(
    config: NormalizedStoredRouterConfig | null,
  ): ManagedPlatformRouterSecretConfig | null {
    if (!config) return null;
    const apiKey = storage.read(credentialStorageEntry(config.credentialFile));
    if (!apiKey) {
      throw new PlatformRouterTransactionError(
        "AI 配置引用的凭据不可用",
      );
    }
    return { ...config, apiKey };
  }

  function publicDraft(
    draft: StoredRouterDraft | null,
    apiKey: string | null,
  ): ManagedPlatformRouterDraftConfig | null {
    if (!draft) return null;
    const digest = apiKey ? draftDigest(draft.config, apiKey) : null;
    const testedReady = Boolean(
      digest &&
        draft.attestation &&
        constantTimeTextEqual(draft.attestation.digest, digest),
    );
    return {
      ...presentManagedConfig(draft.config, Boolean(apiKey)),
      testedReady,
      testedAt: draft.attestation?.testedAt ?? null,
      keyChanged: draft.metadata.keyChanged,
    };
  }

  function publicState(
    snapshot: PlatformRouterSnapshot,
    activeApiKey: string | null,
    draftApiKey: string | null,
  ): TransactionalManagedPlatformRouterPublicState {
    return {
      config: snapshot.active
        ? presentManagedConfig(snapshot.active, Boolean(activeApiKey))
        : null,
      draft: publicDraft(snapshot.draft, draftApiKey),
    };
  }

  function getState(): TransactionalManagedPlatformRouterPublicState {
    const snapshot = readValidatedSnapshot();
    return publicState(
      snapshot,
      readSecret(snapshot.active)?.apiKey ?? null,
      readSecret(snapshot.draft?.config ?? null)?.apiKey ?? null,
    );
  }

  function getActive(): ManagedPlatformRouterConfig | null {
    return getState().config;
  }

  function getDraft(): ManagedPlatformRouterDraftConfig | null {
    return getState().draft;
  }

  function prepareDraftProbe(): PlatformRouterDraftProbe {
    const snapshot = readValidatedSnapshot();
    if (
      snapshot.source !== "generation" ||
      !snapshot.generationId ||
      !snapshot.draft
    ) {
      throw new PlatformRouterConfigValidationError(
        "没有可测试的 AI 待测配置",
      );
    }
    const secret = readSecret(snapshot.draft.config);
    if (!secret) {
      throw new PlatformRouterConfigValidationError(
        "没有可测试的 AI 待测配置",
      );
    }
    const expectedDraftDigest = draftDigest(
      snapshot.draft.config,
      secret.apiKey,
    );
    const draft = publicDraft(snapshot.draft, secret.apiKey);
    if (!draft) {
      throw new PlatformRouterConfigValidationError(
        "没有可测试的 AI 待测配置",
      );
    }
    return {
      draft,
      secret,
      expectedGenerationId: snapshot.generationId,
      expectedDraftDigest,
    };
  }

  async function stage(
    input: ManagedPlatformRouterInput,
    context: PlatformRouterMutationContext,
  ): Promise<PlatformRouterMutationResult<ManagedPlatformRouterDraftConfig>> {
    const auditContext = normalizeMutationContext(context);
    await recoverPlatformRouterTransactions(transactionOptions);
    return withPlatformRouterLock(async (handle) => {
      const current = readValidatedSnapshot();
      const activeApiKey = readSecret(current.active)?.apiKey ?? null;
      const suppliedKey = input.apiKey?.trim() || null;
      const inherited = current.draft?.config ?? current.active;
      const existingKey = readSecret(inherited)?.apiKey ?? null;
      if (!suppliedKey && !existingKey) {
        throw new PlatformRouterConfigValidationError(
          "首次配置时必须填写 API Key",
        );
      }
      const credentialFile = suppliedKey
        ? `platform-router-key-${nextId()}.key`
        : inherited?.credentialFile ?? LEGACY_ROUTER_KEY_FILE;
      const keyChanged = suppliedKey ? suppliedKey !== existingKey : false;
      const config = normalizeManagedRouterInput(input, credentialFile);

      if (suppliedKey) {
        writeCredentialWithReconciliation(
          storage,
          credentialFile,
          suppliedKey,
        );
      }

      const draft: StoredRouterDraft = {
        config,
        metadata: { keyChanged },
        attestation: null,
      };
      const audit = buildPlatformRouterAuditRecord(
        {
          eventId: nextId(),
          action: "stage",
          ...auditContext,
          endpoint: config.endpoint,
          model: config.model,
          enabled: config.enabled,
          keyChanged,
        },
        now(),
      );
      const committed = commitSemanticGeneration(
        current,
        { active: current.active, draft },
        audit.eventId,
        handle,
        transactionOptions,
        nextId,
        [audit],
      );
      const state = publicState(
        committed,
        activeApiKey,
        suppliedKey ?? existingKey,
      );
      const pending = finalizeCommittedGeneration(
        committed,
        handle,
        transactionOptions,
      );
      if (!state.draft) {
        throw new PlatformRouterStateIndeterminateError(
          "AI 待测配置已提交但无法读取",
        );
      }
      return mutationResult(state.draft, state, committed, pending);
    }, transactionOptions);
  }

  async function markTested(
    input: PlatformRouterMarkTestedInput,
  ): Promise<PlatformRouterMutationResult<ManagedPlatformRouterDraftConfig>> {
    const auditContext = normalizeMutationContext(input);
    if (input.status !== undefined && input.status !== "ready") {
      throw new PlatformRouterConfigValidationError("AI 测试状态无效");
    }
    if (!/^[0-9a-f]{64}$/i.test(input.expectedDraftDigest)) {
      throw new PlatformRouterConfigValidationError("AI 待测摘要无效");
    }
    await recoverPlatformRouterTransactions(transactionOptions);
    return withPlatformRouterLock(async (handle) => {
      const current = readValidatedSnapshot();
      const activeApiKey = readSecret(current.active)?.apiKey ?? null;
      if (
        current.source !== "generation" ||
        current.generationId !== input.expectedGenerationId ||
        !current.draft
      ) {
        throw new PlatformRouterConflictError(
          "AI 待测配置已变更，请重新测试",
        );
      }
      const secret = readSecret(current.draft.config);
      if (!secret) {
        throw new PlatformRouterConflictError(
          "AI 待测配置已变更，请重新测试",
        );
      }
      const digest = draftDigest(current.draft.config, secret.apiKey);
      if (!constantTimeTextEqual(digest, input.expectedDraftDigest)) {
        throw new PlatformRouterConflictError(
          "AI 待测配置已变更，请重新测试",
        );
      }
      const attestation: DraftTestAttestation = {
        digest,
        testedAt: now().toISOString(),
        requestId: auditContext.requestId,
      };
      const draft: StoredRouterDraft = {
        ...current.draft,
        attestation,
      };
      const audit = buildPlatformRouterAuditRecord(
        {
          eventId: nextId(),
          action: "test",
          ...auditContext,
          endpoint: draft.config.endpoint,
          model: draft.config.model,
          enabled: draft.config.enabled,
          keyChanged: draft.metadata.keyChanged,
        },
        now(),
      );
      const committed = commitSemanticGeneration(
        current,
        { active: current.active, draft },
        audit.eventId,
        handle,
        transactionOptions,
        nextId,
        [audit],
      );
      const state = publicState(committed, activeApiKey, secret.apiKey);
      const pending = finalizeCommittedGeneration(
        committed,
        handle,
        transactionOptions,
      );
      if (!state.draft) {
        throw new PlatformRouterStateIndeterminateError(
          "AI 测试凭据已提交但无法读取",
        );
      }
      return mutationResult(state.draft, state, committed, pending);
    }, transactionOptions);
  }

  async function activate(
    context: PlatformRouterMutationContext,
  ): Promise<PlatformRouterMutationResult<ManagedPlatformRouterConfig>> {
    const auditContext = normalizeMutationContext(context);
    await recoverPlatformRouterTransactions(transactionOptions);
    return withPlatformRouterLock(async (handle) => {
      const current = readValidatedSnapshot();
      if (!current.draft?.attestation) {
        throw new PlatformRouterConfigValidationError(
          "请先成功测试待测配置",
        );
      }
      const secret = readSecret(current.draft.config);
      if (!secret) {
        throw new PlatformRouterConfigValidationError(
          "请先成功测试待测配置",
        );
      }
      const digest = draftDigest(current.draft.config, secret.apiKey);
      if (
        !constantTimeTextEqual(current.draft.attestation.digest, digest)
      ) {
        throw new PlatformRouterConflictError(
          "待测配置已变更，请重新测试",
        );
      }
      if (!current.draft.config.enabled) {
        throw new PlatformRouterConfigValidationError(
          "请先勾选启用商城 AI 导购",
        );
      }
      const active = normalizeStoredRouterConfig(current.draft.config);
      const audit = buildPlatformRouterAuditRecord(
        {
          eventId: nextId(),
          action: "activate",
          ...auditContext,
          endpoint: active.endpoint,
          model: active.model,
          enabled: active.enabled,
          keyChanged: current.draft.metadata.keyChanged,
        },
        now(),
      );
      const committed = commitSemanticGeneration(
        current,
        { active, draft: null },
        audit.eventId,
        handle,
        transactionOptions,
        nextId,
        [audit],
      );
      const state = publicState(committed, secret.apiKey, null);
      const pending = finalizeCommittedGeneration(
        committed,
        handle,
        transactionOptions,
      );
      if (!state.config) {
        throw new PlatformRouterStateIndeterminateError(
          "AI 配置已提交但无法读取",
        );
      }
      return mutationResult(state.config, state, committed, pending);
    }, transactionOptions);
  }

  return {
    readActive: () => readSecret(readValidatedSnapshot().active),
    readDraft: () => {
      const snapshot = readValidatedSnapshot();
      return readSecret(snapshot.draft?.config ?? null);
    },
    getState,
    getActive,
    getDraft,
    prepareDraftProbe,
    stage,
    markTested,
    activate,
  };
}

interface ExpectedCommittedState {
  active: NormalizedStoredRouterConfig | null;
  draft: StoredRouterDraft | null;
}

interface FinalizationState {
  auditPending: boolean;
  maintenancePending: boolean;
}

function commitSemanticGeneration(
  current: PlatformRouterSnapshot,
  expected: ExpectedCommittedState,
  auditEventId: string,
  handle: PlatformRouterLockHandle,
  options: PlatformRouterTransactionOptions,
  nextId: () => string,
  newAudit: PlatformRouterSnapshot["pendingAudit"],
): PlatformRouterSnapshot {
  const generationId = nextId();
  try {
    return commitGeneration(
      {
        generationId,
        parentGenerationId: current.generationId,
        active: expected.active,
        draft: expected.draft,
        pendingAudit: [...current.pendingAudit, ...newAudit],
      },
      handle,
      options,
    );
  } catch (cause) {
    if (!(cause instanceof PlatformRouterCommitUncertainError)) throw cause;
    let visible: PlatformRouterSnapshot;
    try {
      visible = readCurrentSnapshot(options);
      validateReferencedCredentials(visible, options);
    } catch (reconciliationCause) {
      throw new PlatformRouterStateIndeterminateError(
        "AI 配置提交状态无法确认",
        { cause: reconciliationCause },
      );
    }
    if (
      visible.source === "generation" &&
      visible.generationId === generationId &&
      visible.parentGenerationId === current.generationId &&
      visible.pendingAudit.some((record) => record.eventId === auditEventId) &&
      sameState(visible, expected)
    ) {
      return visible;
    }
    throw new PlatformRouterStateIndeterminateError(
      "AI 配置提交状态无法确认",
      { cause },
    );
  }
}

function finalizeCommittedGeneration(
  committed: PlatformRouterSnapshot,
  handle: PlatformRouterLockHandle,
  options: PlatformRouterTransactionOptions,
): FinalizationState {
  let auditPending = committed.pendingAudit.length > 0;
  let maintenancePending = false;
  try {
    const audit = flushAuditOutbox(committed, handle, options);
    try {
      checkpointDeliveredAudit(
        committed,
        audit.deliveredEventIds,
        handle,
        options,
      );
      auditPending = false;
    } catch {
      auditPending = pendingAuditStillVisible(
        committed.pendingAudit.map((record) => record.eventId),
        options,
      );
    }
  } catch {
    auditPending = pendingAuditStillVisible(
      committed.pendingAudit.map((record) => record.eventId),
      options,
    );
  }

  try {
    // B2b-ops post-drain owns recognized temp-orphan cleanup. A pre-cutover
    // Web process may still be writing those files, so B2b-web must not delete them.
    garbageCollectPlatformRouterArtifacts(handle, options);
  } catch {
    maintenancePending = true;
  }
  return { auditPending, maintenancePending };
}

function pendingAuditStillVisible(
  eventIds: string[],
  options: PlatformRouterTransactionOptions,
): boolean {
  try {
    const visible = readCurrentSnapshot(options);
    const pending = new Set(visible.pendingAudit.map((record) => record.eventId));
    return eventIds.some((eventId) => pending.has(eventId));
  } catch {
    return true;
  }
}

function writeCredentialWithReconciliation(
  storage: ProtectedPlatformRouterStorage,
  credentialFile: string,
  suppliedKey: string,
): void {
  const entry = credentialStorageEntry(credentialFile);
  try {
    storage.write(entry, suppliedKey, "API Key");
  } catch (cause) {
    if (!(cause instanceof ProtectedStorageCommitUncertainError)) throw cause;
    let visible: string | null = null;
    try {
      visible = storage.read(entry);
    } catch (readCause) {
      throw new PlatformRouterStorageUncertainError(
        "AI 凭据提交状态无法确认",
        { cause: readCause },
      );
    }
    if (
      visible !== null &&
      constantTimeTextEqual(visible, suppliedKey)
    ) {
      return;
    }
    throw new PlatformRouterStorageUncertainError(
      "AI 凭据提交状态无法确认",
      { cause },
    );
  }
}

function mutationResult<T>(
  value: T,
  state: TransactionalManagedPlatformRouterPublicState,
  committed: PlatformRouterSnapshot,
  pending: FinalizationState,
): PlatformRouterMutationResult<T> {
  if (!committed.generationId) {
    throw new PlatformRouterStateIndeterminateError(
      "AI 配置已提交但代际身份缺失",
    );
  }
  return {
    value,
    state,
    committed: true,
    auditPending: pending.auditPending,
    maintenancePending: pending.maintenancePending,
    generationId: committed.generationId,
  };
}

function normalizeMutationContext(
  context: PlatformRouterMutationContext,
): PlatformRouterMutationContext {
  return {
    actor: boundedAuditText(context.actor, "actor"),
    requestId: boundedAuditText(context.requestId, "request id"),
  };
}

function emptySnapshot(): PlatformRouterSnapshot {
  return {
    source: "empty",
    pointer: null,
    generationId: null,
    parentGenerationId: null,
    committedAt: null,
    active: null,
    draft: null,
    pendingAudit: [],
  };
}

function isNodeErrorCode(cause: unknown, code: string): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    (cause as NodeJS.ErrnoException).code === code
  );
}

function sameState(
  snapshot: PlatformRouterSnapshot,
  expected: ExpectedCommittedState,
): boolean {
  return (
    JSON.stringify(snapshot.active) === JSON.stringify(expected.active) &&
    JSON.stringify(snapshot.draft) === JSON.stringify(expected.draft)
  );
}

function draftDigest(
  config: NormalizedStoredRouterConfig,
  apiKey: string,
): string {
  const normalizedConfig = normalizeStoredRouterConfig(config);
  return createHash("sha256")
    .update(JSON.stringify(normalizedConfig))
    .update("\0")
    .update(apiKey)
    .digest("hex");
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

const productionTransactionalLifecycle =
  createTransactionalManagedPlatformRouterLifecycle();

export function readTransactionalManagedPlatformRouterConfig(): ManagedPlatformRouterSecretConfig | null {
  return productionTransactionalLifecycle.readActive();
}

export function getTransactionalManagedPlatformRouterState(
  transactionOptions?: PlatformRouterTransactionOptions,
): TransactionalManagedPlatformRouterPublicState {
  if (transactionOptions) {
    return createTransactionalManagedPlatformRouterLifecycle({
      transactionOptions,
    }).getState();
  }
  return productionTransactionalLifecycle.getState();
}

export function getTransactionalManagedPlatformRouterConfig(): ManagedPlatformRouterConfig | null {
  return productionTransactionalLifecycle.getActive();
}

export function prepareTransactionalManagedPlatformRouterDraftProbe(): PlatformRouterDraftProbe {
  return productionTransactionalLifecycle.prepareDraftProbe();
}

export async function stageTransactionalManagedPlatformRouterConfig(
  input: ManagedPlatformRouterInput,
  context: PlatformRouterMutationContext,
): Promise<PlatformRouterMutationResult<ManagedPlatformRouterDraftConfig>> {
  return productionTransactionalLifecycle.stage(input, context);
}

export async function markTransactionalManagedPlatformRouterDraftTested(
  input: PlatformRouterMarkTestedInput,
): Promise<PlatformRouterMutationResult<ManagedPlatformRouterDraftConfig>> {
  return productionTransactionalLifecycle.markTested(input);
}

export async function activateTransactionalManagedPlatformRouterDraft(
  context: PlatformRouterMutationContext,
): Promise<PlatformRouterMutationResult<ManagedPlatformRouterConfig>> {
  return productionTransactionalLifecycle.activate(context);
}

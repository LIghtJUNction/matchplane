import { createHash } from "node:crypto";
import {
  boundedAuditText,
  decodeStoredRouterConfig,
  isRecord,
  LEGACY_ROUTER_KEY_FILE,
  MANAGED_ROUTER_KEY_FILE,
  type DraftMetadata,
  type DraftTestAttestation,
  type ManagedPlatformRouterConfig,
  type ManagedPlatformRouterDraftConfig,
  type ManagedPlatformRouterInput,
  type ManagedPlatformRouterSecretConfig,
  type NormalizedStoredRouterConfig,
  normalizeManagedRouterInput,
  normalizeStoredRouterConfig,
  parseJson,
  presentManagedConfig,
} from "./contract";
import {
  credentialStorageEntry,
  type PlatformRouterStorageEntry,
  type ProtectedPlatformRouterStorage,
} from "./protected-storage";
import {
  getTransactionalManagedPlatformRouterConfig,
  readTransactionalManagedPlatformRouterConfig,
} from "./transactional-lifecycle";
import { PlatformRouterConflictError } from "./transaction";

const DRAFT_ENTRIES: PlatformRouterStorageEntry[] = [
  "draft-config",
  "draft-metadata",
  "draft-attestation",
];
const ACTIVATION_ENTRIES: PlatformRouterStorageEntry[] = [
  "active-config",
  ...DRAFT_ENTRIES,
];

type StorageSnapshot = Map<PlatformRouterStorageEntry, string | null>;

export interface ManagedPlatformRouterLifecycle {
  readActive(): ManagedPlatformRouterSecretConfig | null;
  readDraft(): ManagedPlatformRouterSecretConfig | null;
  getActive(): ManagedPlatformRouterConfig | null;
  getDraft(): ManagedPlatformRouterDraftConfig | null;
  stage(input: ManagedPlatformRouterInput): ManagedPlatformRouterDraftConfig;
  markTested(requestId: string): void;
  activate(): ManagedPlatformRouterConfig;
}

interface LifecycleDependencies {
  storage: ProtectedPlatformRouterStorage;
  nextId(): string;
  now(): Date;
  transactionalStatePresent?(): boolean;
}

export function createManagedPlatformRouterLifecycle(
  dependencies: LifecycleDependencies,
): ManagedPlatformRouterLifecycle {
  const { storage } = dependencies;

  function assertLegacyMutationAllowed(): void {
    if (dependencies.transactionalStatePresent?.()) {
      throw new PlatformRouterConflictError(
        "事务型 AI 配置已启用，旧版写入已拒绝",
      );
    }
  }

  function readConfig(
    entry: "active-config" | "draft-config",
  ): NormalizedStoredRouterConfig | null {
    return decodeStoredRouterConfig(storage.read(entry));
  }

  function readSecret(
    entry: "active-config" | "draft-config",
  ): ManagedPlatformRouterSecretConfig | null {
    const config = readConfig(entry);
    if (!config) return null;
    const apiKey = storage.read(credentialStorageEntry(config.credentialFile));
    return apiKey ? { ...config, apiKey } : null;
  }

  function getActive(): ManagedPlatformRouterConfig | null {
    const config = readConfig("active-config");
    if (!config) return null;
    return presentManagedConfig(
      config,
      Boolean(storage.read(credentialStorageEntry(config.credentialFile))),
    );
  }

  function getDraft(): ManagedPlatformRouterDraftConfig | null {
    const config = readConfig("draft-config");
    if (!config) return null;
    const apiKey = storage.read(credentialStorageEntry(config.credentialFile));
    const metadata = decodeDraftMetadata(storage.read("draft-metadata"));
    const attestation = decodeDraftAttestation(
      storage.read("draft-attestation"),
    );
    return {
      ...presentManagedConfig(config, Boolean(apiKey)),
      testedReady: Boolean(
        apiKey &&
          attestation &&
          constantTimeTextEqual(attestation.digest, draftDigest(config, apiKey)),
      ),
      testedAt: attestation?.testedAt ?? null,
      keyChanged: metadata?.keyChanged ?? false,
    };
  }

  function stage(
    input: ManagedPlatformRouterInput,
  ): ManagedPlatformRouterDraftConfig {
    assertLegacyMutationAllowed();
    const snapshot = captureSnapshot(storage, DRAFT_ENTRIES);
    const previousDraft = readConfig("draft-config");
    const active = readConfig("active-config");
    const suppliedKey = input.apiKey?.trim() || null;
    const inheritedCredential = previousDraft?.credentialFile
      ? previousDraft
      : active;
    const credentialFile = suppliedKey
      ? `platform-router-key-${dependencies.nextId()}.key`
      : inheritedCredential?.credentialFile ?? LEGACY_ROUTER_KEY_FILE;
    const existingKey = inheritedCredential
      ? storage.read(credentialStorageEntry(inheritedCredential.credentialFile))
      : null;
    if (!suppliedKey && !existingKey) {
      throw new Error("首次配置时必须填写 API Key");
    }
    const keyChanged = suppliedKey ? suppliedKey !== existingKey : false;
    const config = normalizeManagedRouterInput(input, credentialFile);
    const createdCredential = suppliedKey
      ? credentialStorageEntry(credentialFile)
      : null;

    try {
      if (suppliedKey) storage.write(createdCredential!, suppliedKey, "API Key");
      storage.write("draft-config", JSON.stringify(config), "AI 待测配置");
      storage.write(
        "draft-metadata",
        JSON.stringify({ keyChanged } satisfies DraftMetadata),
        "AI 待测元数据",
      );
      storage.remove("draft-attestation");
      const draft = getDraft();
      if (!draft) throw new Error("AI 待测配置保存失败");
      removeUnusedCredential(storage, previousDraft, config.credentialFile);
      return draft;
    } catch (cause) {
      rollback(storage, snapshot, createdCredential, cause);
    }
  }

  function markTested(requestId: string): void {
    assertLegacyMutationAllowed();
    const draft = readSecret("draft-config");
    if (!draft) throw new Error("没有可测试的 AI 待测配置");
    storage.write(
      "draft-attestation",
      JSON.stringify({
        digest: draftDigest(draft, draft.apiKey),
        testedAt: dependencies.now().toISOString(),
        requestId: boundedAuditText(requestId, "request id"),
      } satisfies DraftTestAttestation),
      "AI 测试凭据",
    );
  }

  function activate(): ManagedPlatformRouterConfig {
    assertLegacyMutationAllowed();
    const snapshot = captureSnapshot(storage, ACTIVATION_ENTRIES);
    const previousActive = readConfig("active-config");
    const draft = readSecret("draft-config");
    const attestation = decodeDraftAttestation(
      storage.read("draft-attestation"),
    );
    if (!draft || !attestation) throw new Error("请先成功测试待测配置");
    if (!constantTimeTextEqual(attestation.digest, draftDigest(draft, draft.apiKey))) {
      throw new Error("待测配置已变更，请重新测试");
    }
    if (!draft.enabled) throw new Error("请先勾选启用商城 AI 导购");
    const { apiKey: _apiKey, ...config } = draft;

    try {
      storage.write("active-config", JSON.stringify(config), "AI 配置");
      const active = getActive();
      if (!active) throw new Error("AI 配置启用失败");
      for (const entry of DRAFT_ENTRIES) storage.remove(entry);
      removeUnusedCredential(storage, previousActive, config.credentialFile);
      return active;
    } catch (cause) {
      rollback(storage, snapshot, null, cause);
    }
  }

  return {
    readActive: () => readSecret("active-config"),
    readDraft: () => readSecret("draft-config"),
    getActive,
    getDraft,
    stage,
    markTested,
    activate,
  };
}

export function readManagedPlatformRouterConfig(): ManagedPlatformRouterSecretConfig | null {
  return readTransactionalManagedPlatformRouterConfig();
}

export function getManagedPlatformRouterConfig(): ManagedPlatformRouterConfig | null {
  return getTransactionalManagedPlatformRouterConfig();
}

function captureSnapshot(
  storage: ProtectedPlatformRouterStorage,
  entries: PlatformRouterStorageEntry[],
): StorageSnapshot {
  return new Map(entries.map((entry) => [entry, storage.read(entry)]));
}

function rollback(
  storage: ProtectedPlatformRouterStorage,
  snapshot: StorageSnapshot,
  createdCredential: PlatformRouterStorageEntry | null,
  operationCause: unknown,
): never {
  const rollbackErrors: Error[] = [];
  if (createdCredential) {
    try {
      storage.remove(createdCredential);
    } catch (cause) {
      rollbackErrors.push(asError(cause));
    }
  }
  for (const [entry, value] of snapshot) {
    try {
      if (value === null) storage.remove(entry);
      else storage.write(entry, value, "AI 配置回滚");
    } catch (cause) {
      rollbackErrors.push(asError(cause));
    }
  }
  if (rollbackErrors.length > 0) {
    throw new Error("AI 配置事务失败且回滚未完成", {
      cause: new AggregateError([asError(operationCause), ...rollbackErrors]),
    });
  }
  throw operationCause;
}

function removeUnusedCredential(
  storage: ProtectedPlatformRouterStorage,
  previous: NormalizedStoredRouterConfig | null,
  currentCredentialFile: string,
): void {
  if (
    previous &&
    previous.credentialFile !== currentCredentialFile &&
    previous.credentialFile !== LEGACY_ROUTER_KEY_FILE &&
    MANAGED_ROUTER_KEY_FILE.test(previous.credentialFile)
  ) {
    storage.remove(credentialStorageEntry(previous.credentialFile));
  }
}

function decodeDraftMetadata(raw: string | null): DraftMetadata | null {
  if (raw === null) return null;
  const value = parseJson(raw);
  return isRecord(value) && typeof value.keyChanged === "boolean"
    ? { keyChanged: value.keyChanged }
    : null;
}

function decodeDraftAttestation(
  raw: string | null,
): DraftTestAttestation | null {
  if (raw === null) return null;
  const value = parseJson(raw);
  return isRecord(value) &&
    typeof value.digest === "string" &&
    typeof value.testedAt === "string" &&
    typeof value.requestId === "string"
    ? {
        digest: value.digest,
        testedAt: value.testedAt,
        requestId: value.requestId,
      }
    : null;
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

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

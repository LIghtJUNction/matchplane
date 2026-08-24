import type { ManagedPlatformRouterState } from "./platform-router-config/contract";
import {
  platformRouterEffectiveStatusFrom,
  readEnvironmentProviderStatus,
  unreadableManagedPlatformRouterEffectiveStatus,
} from "./platform-router-config/effective-source";
import type { PlatformRouterTransactionOptions } from "./platform-router-config/transaction";
import { getTransactionalManagedPlatformRouterState } from "./platform-router-config/transactional-lifecycle";

export type {
  ManagedPlatformRouterConfig,
  ManagedPlatformRouterDraftConfig,
  ManagedPlatformRouterInput,
  ManagedPlatformRouterState,
  ManagedRouterModel,
  ManagedRouterProtocol,
  PlatformRouterAuditEvent,
  PlatformRouterEffectiveStatus,
} from "./platform-router-config/contract";
export {
  appendPlatformRouterAudit,
  buildPlatformRouterAuditRecord,
} from "./platform-router-config/audit";
export type { PlatformRouterAuditRecord } from "./platform-router-config/audit";
export {
  acquirePlatformRouterLock,
  checkpointDeliveredAudit,
  cleanupRecognizedOrphanTemps,
  commitGeneration,
  flushAuditOutbox,
  garbageCollectPlatformRouterArtifacts,
  PlatformRouterCommitUncertainError,
  PlatformRouterConflictError,
  PlatformRouterCorruptionError,
  PlatformRouterLockOwnershipError,
  PlatformRouterLockTimeoutError,
  PlatformRouterTransactionError,
  PlatformRouterValidationError,
  readCurrentSnapshot,
  recoverPlatformRouterTransactions,
  validateReferencedCredentials,
  withPlatformRouterLock,
} from "./platform-router-config/transaction";
export type {
  PlatformRouterGeneration,
  PlatformRouterGenerationInput,
  PlatformRouterLockHandle,
  PlatformRouterPointer,
  PlatformRouterRecoveryResult,
  PlatformRouterSnapshot,
  PlatformRouterTransactionOptions,
} from "./platform-router-config/transaction";
export {
  getPlatformRouterEffectiveStatus,
  platformRouterPolicyIssues,
} from "./platform-router-config/effective-source";
export {
  activateTransactionalManagedPlatformRouterDraft,
  createTransactionalManagedPlatformRouterLifecycle,
  getTransactionalManagedPlatformRouterConfig,
  getTransactionalManagedPlatformRouterDraftConfig,
  getTransactionalManagedPlatformRouterState,
  markTransactionalManagedPlatformRouterDraftTested,
  PlatformRouterStateIndeterminateError,
  PlatformRouterStorageUncertainError,
  prepareTransactionalManagedPlatformRouterDraftProbe,
  readTransactionalManagedPlatformRouterConfig,
  readTransactionalManagedPlatformRouterDraftConfig,
  stageTransactionalManagedPlatformRouterConfig,
} from "./platform-router-config/transactional-lifecycle";
export type {
  PlatformRouterDraftProbe,
  PlatformRouterMarkTestedInput,
  PlatformRouterMutationContext,
  PlatformRouterMutationResult,
  TransactionalLifecycleDependencies,
  TransactionalManagedPlatformRouterLifecycle,
  TransactionalManagedPlatformRouterPublicState,
} from "./platform-router-config/transactional-lifecycle";
export {
  activateManagedPlatformRouterDraft,
  getManagedPlatformRouterDraftConfig,
  markManagedPlatformRouterDraftTested,
  readManagedPlatformRouterConfig,
  readManagedPlatformRouterDraftConfig,
  stageManagedPlatformRouterConfig,
} from "./platform-router-config/lifecycle";
export {
  listManagedPlatformRouterModels,
  modelReasoningEffortsFromRecord,
} from "./platform-router-config/models";

export function getManagedPlatformRouterState(
  transactionOptions?: PlatformRouterTransactionOptions,
): ManagedPlatformRouterState {
  const environment = readEnvironmentProviderStatus();
  try {
    const state = getTransactionalManagedPlatformRouterState(
      transactionOptions,
    );
    return {
      ...state,
      effective: platformRouterEffectiveStatusFrom(
        state.config,
        environment,
      ),
    };
  } catch {
    return {
      config: null,
      draft: null,
      effective: unreadableManagedPlatformRouterEffectiveStatus(
        environment,
      ),
    };
  }
}

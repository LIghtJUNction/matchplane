import type { ManagedPlatformRouterState } from "./platform-router-config/contract";
import {
  platformRouterEffectiveStatusFrom,
  readEnvironmentProviderStatus,
  unreadableManagedPlatformRouterEffectiveStatus,
  type EnvironmentProviderStatus,
} from "./platform-router-config/effective-source";
import type { PlatformRouterTransactionOptions } from "./platform-router-config/transaction";
import {
  getTransactionalManagedPlatformRouterState,
  type TransactionalManagedPlatformRouterPublicState,
} from "./platform-router-config/transactional-lifecycle";

export type { ManagedRouterProtocol } from "./platform-router-config/contract";
export {
  PlatformRouterConflictError,
  PlatformRouterLockTimeoutError,
  PlatformRouterTransactionError,
} from "./platform-router-config/transaction";
export {
  activateTransactionalManagedPlatformRouterDraft,
  markTransactionalManagedPlatformRouterDraftTested,
  PlatformRouterStateIndeterminateError,
  PlatformRouterStorageUncertainError,
  prepareTransactionalManagedPlatformRouterDraftProbe,
  stageTransactionalManagedPlatformRouterConfig,
} from "./platform-router-config/transactional-lifecycle";
export type {
  PlatformRouterDraftProbe,
  PlatformRouterMutationResult,
} from "./platform-router-config/transactional-lifecycle";
export {
  getPlatformRouterEffectiveStatus,
  platformRouterPolicyIssues,
} from "./platform-router-config/effective-source";
export { readManagedPlatformRouterConfig } from "./platform-router-config/lifecycle";

export function managedPlatformRouterStateFromTransactionalState(
  state: TransactionalManagedPlatformRouterPublicState,
  environment: EnvironmentProviderStatus = readEnvironmentProviderStatus(),
): ManagedPlatformRouterState {
  return {
    ...state,
    effective: platformRouterEffectiveStatusFrom(state.config, environment),
  };
}

export function getManagedPlatformRouterState(
  transactionOptions?: PlatformRouterTransactionOptions,
): ManagedPlatformRouterState {
  const environment = readEnvironmentProviderStatus();
  try {
    return managedPlatformRouterStateFromTransactionalState(
      getTransactionalManagedPlatformRouterState(transactionOptions),
      environment,
    );
  } catch {
    return {
      config: null,
      draft: null,
      effective: unreadableManagedPlatformRouterEffectiveStatus(environment),
    };
  }
}

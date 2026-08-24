import type { ManagedPlatformRouterState } from "./platform-router-config/contract";
import { getPlatformRouterEffectiveStatus } from "./platform-router-config/effective-source";
import {
  getManagedPlatformRouterConfig,
  getManagedPlatformRouterDraftConfig,
} from "./platform-router-config/lifecycle";

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
export { appendPlatformRouterAudit } from "./platform-router-config/audit";
export {
  getPlatformRouterEffectiveStatus,
  platformRouterPolicyIssues,
} from "./platform-router-config/effective-source";
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

export function getManagedPlatformRouterState(): ManagedPlatformRouterState {
  return {
    config: getManagedPlatformRouterConfig(),
    draft: getManagedPlatformRouterDraftConfig(),
    effective: getPlatformRouterEffectiveStatus(),
  };
}

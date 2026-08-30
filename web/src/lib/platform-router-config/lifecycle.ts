import type {
  ManagedPlatformRouterConfig,
  ManagedPlatformRouterSecretConfig,
} from "./contract";
import {
  getTransactionalManagedPlatformRouterConfig,
  readTransactionalManagedPlatformRouterConfig,
} from "./transactional-lifecycle";

export function readManagedPlatformRouterConfig(): ManagedPlatformRouterSecretConfig | null {
  return readTransactionalManagedPlatformRouterConfig();
}

export function getManagedPlatformRouterConfig(): ManagedPlatformRouterConfig | null {
  return getTransactionalManagedPlatformRouterConfig();
}

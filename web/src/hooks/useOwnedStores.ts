"use client";

import { useCallback, useEffect, useState } from "react";
import { getOwnedStores, type StoreSummary } from "../api";
import { loadSubplatform, type SubplatformConfig } from "../subplatform";
import type { AuthenticatedUser } from "./useAuthSession";
import { isTransientAuthError, waitForAuthRetry } from "./useAuthSession";
import type { AccountSettingsSection } from "./useSubplatformRoute";

export interface StoreConsoleContext {
  subplatform: SubplatformConfig;
  store: StoreSummary;
}

function canManageStore(
  user: AuthenticatedUser | null,
  store: StoreSummary | null,
): boolean {
  return Boolean(
    user &&
      store &&
      (user.role === "rootSuperAdmin" ||
        user.role === "rootAdmin" ||
        store.membershipRole === "owner" ||
        store.membershipRole === "mall_operator"),
  );
}

async function getOwnedStoresWithRetry(): Promise<StoreSummary[]> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await getOwnedStores();
    } catch (error) {
      if (attempt >= 3 || !isTransientAuthError(error)) throw error;
      await waitForAuthRetry(attempt);
    }
  }
  return [];
}

interface UseOwnedStoresOptions {
  authUser: AuthenticatedUser | null;
  subplatform: SubplatformConfig;
  locale: "zh" | "en";
  storeConsoleRequested: boolean;
  setStoreConsoleRequested: (val: boolean) => void;
  storeConsoleRequestedStoreId: string | null;
  setStoreConsoleRequestedStoreId: (value: string | null) => void;
  setAccountSettingsSection: (section: AccountSettingsSection | null) => void;
  onNotice: (message: string) => void;
  openSignIn: () => void;
}

export function useOwnedStores({
  authUser,
  subplatform,
  locale,
  storeConsoleRequested,
  setStoreConsoleRequested,
  storeConsoleRequestedStoreId,
  setStoreConsoleRequestedStoreId,
  setAccountSettingsSection,
  onNotice,
  openSignIn,
}: UseOwnedStoresOptions) {
  const [ownedStores, setOwnedStores] = useState<StoreSummary[]>([]);
  const [ownedStoresError, setOwnedStoresError] = useState<string | null>(null);
  const [ownedStoresResolved, setOwnedStoresResolved] = useState(false);
  const [storeConsoleOpen, setStoreConsoleOpen] = useState(false);
  const [storeConsoleContext, setStoreConsoleContext] =
    useState<StoreConsoleContext | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!authUser?.id) {
      setOwnedStores([]);
      setOwnedStoresError(null);
      setOwnedStoresResolved(false);
      return () => {
        cancelled = true;
      };
    }
    setOwnedStoresError(null);
    setOwnedStoresResolved(false);
    void getOwnedStoresWithRetry()
      .then((stores) => {
        if (!cancelled) setOwnedStores(stores);
      })
      .catch((error) => {
        if (!cancelled) {
          const message =
            error instanceof Error
              ? error.message
              : "我的店铺暂时无法读取，请稍后重试";
          setOwnedStoresError(message);
          onNotice(message);
        }
      })
      .finally(() => {
        if (!cancelled) setOwnedStoresResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [authUser?.id, onNotice]);

  const openStoreConsoleFor = useCallback(
    async (store: StoreSummary) => {
      try {
        const storeSubplatform = await loadSubplatform(store.path);
        setStoreConsoleContext({ subplatform: storeSubplatform, store });
        setStoreConsoleOpen(true);
      } catch (error) {
        onNotice(
          error instanceof Error
            ? error.message
            : locale === "en"
              ? "The store workspace is temporarily unavailable."
              : "店铺工作台暂时不可用",
        );
        setAccountSettingsSection("stores");
      }
    },
    [locale, onNotice, setAccountSettingsSection],
  );

  const currentManagedStore =
    subplatform.slug === "root"
      ? null
      : (ownedStores.find((store) => store.path === subplatform.path) ?? null);

  useEffect(() => {
    if (!storeConsoleRequested || !ownedStoresResolved) return;
    setStoreConsoleRequested(false);
    if (!authUser) {
      openSignIn();
      return;
    }
    const requestedStore = storeConsoleRequestedStoreId
      ? (ownedStores.find(
          (store) => store.id === storeConsoleRequestedStoreId,
        ) ?? null)
      : currentManagedStore;
    setStoreConsoleRequestedStoreId(null);
    if (!requestedStore) {
      onNotice("只有店主或店铺运营人员可以管理这家店");
      return;
    }
    if (storeConsoleRequestedStoreId) {
      void openStoreConsoleFor(requestedStore);
      return;
    }
    setStoreConsoleContext({ subplatform, store: requestedStore });
    setStoreConsoleOpen(true);
  }, [
    authUser,
    currentManagedStore,
    onNotice,
    openSignIn,
    openStoreConsoleFor,
    ownedStores,
    ownedStoresResolved,
    setStoreConsoleRequested,
    setStoreConsoleRequestedStoreId,
    storeConsoleRequested,
    storeConsoleRequestedStoreId,
    subplatform,
  ]);

  const canManageStoreConsole = canManageStore(
    authUser,
    storeConsoleContext?.store ?? null,
  );

  return {
    ownedStores,
    setOwnedStores,
    ownedStoresError,
    ownedStoresResolved,
    storeConsoleOpen,
    setStoreConsoleOpen,
    storeConsoleContext,
    setStoreConsoleContext,
    currentManagedStore,
    canManageStoreConsole,
    openStoreConsoleFor,
  };
}

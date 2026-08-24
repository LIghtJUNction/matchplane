"use client";

import { useCallback, useEffect, useState } from "react";
import { getOwnedStores, type StoreSummary } from "../api";
import { loadSubplatform, type SubplatformConfig } from "../subplatform";
import type { AuthenticatedUser } from "./useAuthSession";
import { isTransientAuthError, waitForAuthRetry } from "./useAuthSession";
import { relativeBrowserLocation, type AccountSettingsSection } from "./useSubplatformRoute";

export interface StoreConsoleContext {
  subplatform: SubplatformConfig;
  store: StoreSummary;
}

export function canManageStore(
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
  authResolved: boolean;
  subplatform: SubplatformConfig;
  locale: "zh" | "en";
  storeConsoleRequested: boolean;
  setStoreConsoleRequested: (val: boolean) => void;
  publishProductRequested: boolean;
  setPublishProductRequested: (val: boolean) => void;
  setAccountSettingsSection: (section: AccountSettingsSection | null) => void;
  onNotice: (message: string) => void;
  openSignIn: () => void;
}

export function useOwnedStores({
  authUser,
  authResolved,
  subplatform,
  locale,
  storeConsoleRequested,
  setStoreConsoleRequested,
  publishProductRequested,
  setPublishProductRequested,
  setAccountSettingsSection,
  onNotice,
  openSignIn,
}: UseOwnedStoresOptions) {
  const [ownedStores, setOwnedStores] = useState<StoreSummary[]>([]);
  const [ownedStoresResolved, setOwnedStoresResolved] = useState(false);
  const [storeConsoleOpen, setStoreConsoleOpen] = useState(false);
  const [storeConsoleContext, setStoreConsoleContext] =
    useState<StoreConsoleContext | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!authUser?.id) {
      setOwnedStores([]);
      setOwnedStoresResolved(false);
      return () => {
        cancelled = true;
      };
    }
    setOwnedStoresResolved(false);
    void getOwnedStoresWithRetry()
      .then((stores) => {
        if (!cancelled) setOwnedStores(stores);
      })
      .catch((error) => {
        if (!cancelled) {
          onNotice(
            error instanceof Error
              ? error.message
              : "我的店铺暂时无法读取，请稍后重试",
          );
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
    if (!currentManagedStore) {
      onNotice("只有店主或店铺运营人员可以管理这家店");
      return;
    }
    setStoreConsoleContext({ subplatform, store: currentManagedStore });
    setStoreConsoleOpen(true);
  }, [
    authUser,
    currentManagedStore,
    onNotice,
    openSignIn,
    ownedStoresResolved,
    setStoreConsoleRequested,
    storeConsoleRequested,
    subplatform,
  ]);

  useEffect(() => {
    if (!publishProductRequested || !authResolved) return;
    if (!authUser) {
      if (typeof window !== "undefined") {
        window.location.assign(
          `/login?next=${encodeURIComponent("/?publish=1")}`,
        );
      }
      return;
    }
    if (!ownedStoresResolved) return;

    setPublishProductRequested(false);
    if (typeof window !== "undefined") {
      const searchParams = new URLSearchParams(window.location.search);
      searchParams.delete("publish");
      window.history.replaceState(
        null,
        "",
        relativeBrowserLocation(searchParams),
      );
    }
    if (ownedStores.length === 1) {
      void openStoreConsoleFor(ownedStores[0]);
      return;
    }
    setAccountSettingsSection("stores");
  }, [
    authResolved,
    authUser,
    openStoreConsoleFor,
    ownedStores,
    ownedStoresResolved,
    publishProductRequested,
    setAccountSettingsSection,
    setPublishProductRequested,
  ]);

  const publishProduct = useCallback(() => {
    if (!authResolved || (authUser && !ownedStoresResolved)) {
      setPublishProductRequested(true);
      onNotice(locale === "en" ? "Loading your stores…" : "正在读取你的店铺…");
      return;
    }
    if (!authUser) {
      if (typeof window !== "undefined") {
        window.location.assign(
          `/login?next=${encodeURIComponent("/?publish=1")}`,
        );
      }
      return;
    }
    if (ownedStores.length === 1) {
      void openStoreConsoleFor(ownedStores[0]);
      return;
    }
    setAccountSettingsSection("stores");
  }, [
    authResolved,
    authUser,
    locale,
    onNotice,
    openStoreConsoleFor,
    ownedStores,
    ownedStoresResolved,
    setAccountSettingsSection,
    setPublishProductRequested,
  ]);

  const canManageStoreConsole = canManageStore(
    authUser,
    storeConsoleContext?.store ?? null,
  );

  return {
    ownedStores,
    setOwnedStores,
    ownedStoresResolved,
    storeConsoleOpen,
    setStoreConsoleOpen,
    storeConsoleContext,
    setStoreConsoleContext,
    currentManagedStore,
    canManageStoreConsole,
    openStoreConsoleFor,
    publishProduct,
  };
}

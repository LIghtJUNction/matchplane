"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  createRootPlatformOrganization,
  getPlatformAiStatus,
  getPlatformDomains,
  getPlatformSetupStatus,
  type PlatformAiStatus,
  type PlatformDomainRecord,
  type PlatformSetupStatus,
} from "../api";

export type PlatformBootstrapResourceState<T> =
  | { status: "loading"; previous?: T }
  | { status: "ready"; data: T }
  | { status: "error"; message: string; previous?: T };

export type PlatformSetupResourceState =
  PlatformBootstrapResourceState<PlatformSetupStatus>;
export type PlatformDomainsResourceState = PlatformBootstrapResourceState<
  PlatformDomainRecord[]
>;
export type PlatformAiResourceState =
  PlatformBootstrapResourceState<PlatformAiStatus>;

export type PlatformBootstrapResourceKey = "setup" | "domains" | "ai";

interface PlatformBootstrapResourcesInput {
  authorized: boolean;
  rootRole?: string | null;
  onNotice: (message: string) => void;
}

const RESOURCE_KEYS = [
  "setup",
  "domains",
  "ai",
] as const satisfies readonly PlatformBootstrapResourceKey[];

export function usePlatformBootstrapResources({
  authorized,
  rootRole,
  onNotice,
}: PlatformBootstrapResourcesInput) {
  const [setup, setSetup] = useState<PlatformSetupResourceState>({
    status: "loading",
  });
  const [domains, setDomains] = useState<PlatformDomainsResourceState>({
    status: "loading",
  });
  const [ai, setAi] = useState<PlatformAiResourceState>({ status: "loading" });
  const [rootInitializing, setRootInitializing] = useState(false);
  const requestVersions = useRef<Record<PlatformBootstrapResourceKey, number>>({
    setup: 0,
    domains: 0,
    ai: 0,
  });
  const rootRequestVersionRef = useRef(0);
  const rootInitializingRef = useRef(false);
  const mountedRef = useRef(false);

  const loadSetup = useCallback(async () => {
    const requestVersion = ++requestVersions.current.setup;
    setSetup((current) => loadingState(current));
    try {
      const data = await getPlatformSetupStatus();
      if (requestVersions.current.setup !== requestVersion) return;
      setSetup({ status: "ready", data });
    } catch (cause) {
      if (requestVersions.current.setup !== requestVersion) return;
      setSetup((current) =>
        errorState(current, readableError(cause, "商城初始化状态读取失败")),
      );
    }
  }, []);

  const loadDomains = useCallback(async () => {
    const requestVersion = ++requestVersions.current.domains;
    setDomains((current) => loadingState(current));
    try {
      const data = await getPlatformDomains();
      if (requestVersions.current.domains !== requestVersion) return;
      setDomains({ status: "ready", data });
    } catch (cause) {
      if (requestVersions.current.domains !== requestVersion) return;
      setDomains((current) =>
        errorState(current, readableError(cause, "商城数据范围读取失败")),
      );
    }
  }, []);

  const loadAi = useCallback(async () => {
    const requestVersion = ++requestVersions.current.ai;
    setAi((current) => loadingState(current));
    try {
      const data = await getPlatformAiStatus();
      if (requestVersions.current.ai !== requestVersion) return;
      setAi({ status: "ready", data });
    } catch (cause) {
      if (requestVersions.current.ai !== requestVersion) return;
      setAi((current) =>
        errorState(current, readableError(cause, "AI 状态读取失败")),
      );
    }
  }, []);

  const loadResources = useCallback(
    async (keys: readonly PlatformBootstrapResourceKey[]) => {
      await Promise.all(
        keys.map((key) => {
          if (key === "setup") return loadSetup();
          if (key === "domains") return loadDomains();
          return loadAi();
        }),
      );
    },
    [loadAi, loadDomains, loadSetup],
  );

  const refreshSetupAndDomains = useCallback(
    () => loadResources(["setup", "domains"] as const),
    [loadResources],
  );

  useEffect(() => {
    mountedRef.current = true;
    if (authorized) void loadResources(RESOURCE_KEYS);
    return () => {
      mountedRef.current = false;
      requestVersions.current.setup += 1;
      requestVersions.current.domains += 1;
      requestVersions.current.ai += 1;
      rootRequestVersionRef.current += 1;
      rootInitializingRef.current = false;
    };
  }, [authorized, loadResources]);

  const retryFailed = useCallback(() => {
    const states = { setup, domains, ai };
    const failedKeys = RESOURCE_KEYS.filter(
      (key) => states[key].status === "error",
    );
    return loadResources(failedKeys);
  }, [ai, domains, loadResources, setup]);

  const initializeRootOrganization = useCallback(async () => {
    if (setup.status !== "ready") {
      onNotice("商城初始化状态尚未验证，请重新读取后再创建商城组织");
      return;
    }
    if (!setup.data.root.tenantExists || !setup.data.root.tenant) {
      onNotice("根商城尚未由部署工具创建，暂时不能在网页中继续初始化");
      return;
    }
    if (setup.data.root.organization) {
      onNotice("商城组织已经创建，无需重复初始化");
      return;
    }
    if (rootRole !== "rootSuperAdmin") {
      onNotice("只有商城负责人可以创建根商城组织");
      return;
    }
    if (rootInitializingRef.current) return;

    rootInitializingRef.current = true;
    const requestVersion = ++rootRequestVersionRef.current;
    setRootInitializing(true);
    try {
      const organization = await createRootPlatformOrganization({
        name: setup.data.root.tenant.name,
        slug: setup.data.root.tenant.slug,
      });
      if (
        !mountedRef.current ||
        rootRequestVersionRef.current !== requestVersion
      )
        return;
      onNotice(`商城组织“${organization.name}”已创建`);
      await refreshSetupAndDomains();
    } catch (cause) {
      if (
        mountedRef.current &&
        rootRequestVersionRef.current === requestVersion
      ) {
        onNotice(readableError(cause, "商城组织创建失败"));
      }
    } finally {
      if (
        mountedRef.current &&
        rootRequestVersionRef.current === requestVersion
      ) {
        setRootInitializing(false);
        rootInitializingRef.current = false;
      }
    }
  }, [onNotice, refreshSetupAndDomains, rootRole, setup]);

  return {
    setup,
    domains,
    ai,
    rootInitializing,
    initializeRootOrganization,
    retryFailed,
    refreshSetupAndDomains,
  };
}

export function bootstrapResourceData<T>(
  state: PlatformBootstrapResourceState<T>,
): T | undefined {
  return state.status === "ready" ? state.data : state.previous;
}

export function freshBootstrapResourceData<T>(
  state: PlatformBootstrapResourceState<T>,
): T | null {
  return state.status === "ready" ? state.data : null;
}

function loadingState<T>(
  state: PlatformBootstrapResourceState<T>,
): PlatformBootstrapResourceState<T> {
  const previous = bootstrapResourceData(state);
  return previous === undefined
    ? { status: "loading" }
    : { status: "loading", previous };
}

function errorState<T>(
  state: PlatformBootstrapResourceState<T>,
  message: string,
): PlatformBootstrapResourceState<T> {
  const previous = bootstrapResourceData(state);
  return previous === undefined
    ? { status: "error", message }
    : { status: "error", message, previous };
}

function readableError(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim()
    ? cause.message
    : fallback;
}

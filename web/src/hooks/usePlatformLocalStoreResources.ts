"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  activateSubplatform,
  discoverSubplatformSource,
  getSubplatformOrganizations,
  getSubplatformSourceIntake,
  registerSubplatform,
  uploadSubplatformArchive,
  type SubplatformOrganizationRecord,
} from "../api";
import {
  currentActivatableOrganization,
  currentUpdateOrganization,
  localStorePollDelay,
  localStoreWriteBlockReason,
  registrationFromDiscovery,
  validGitLocator,
  writableLocalStoreAuthority,
} from "./platformLocalStoreGuards";
import type {
  PlatformDomainsResourceState,
  PlatformSetupResourceState,
} from "./usePlatformBootstrapResources";

export type LocalStoreResourceState<T> =
  | { status: "loading"; previous?: T }
  | { status: "ready"; data: T }
  | { status: "error"; message: string; previous?: T };

interface LocalStoreRegistrationDraft {
  sourceKind: "git" | "archive";
  domainId: string;
  sourceLocator: string;
  archive: File | null;
  requestedScopes?: string[];
  membershipPolicy: "public" | "invite";
  updateOrganizationId?: string;
}

interface LocalStoreUpdateSeed {
  organizationId: string;
  sourceKind: "git" | "archive";
  domainId: string;
  sourceLocator: string;
  name: string;
}

export interface PlatformLocalStoreController {
  organizations: LocalStoreResourceState<SubplatformOrganizationRecord[]>;
  mutation: "registration" | "activation" | null;
  operationPhase: string;
  registrationCancellable: boolean;
  writeBlockReason: string | null;
  retryAvailable: boolean;
  retryFailed: () => Promise<void>;
  refreshOrganizations: () => Promise<void>;
  cancelRegistration: () => boolean;
  commitRegistration: (draft: LocalStoreRegistrationDraft) => Promise<boolean>;
  commitActivation: (organizationId: string) => Promise<boolean>;
  prepareUpdate: (organizationId: string) => LocalStoreUpdateSeed | null;
}

interface UsePlatformLocalStoreResourcesOptions {
  authorized: boolean;
  apiAvailable: boolean;
  rootRole?: string | null;
  setup: PlatformSetupResourceState;
  domains: PlatformDomainsResourceState;
  onNotice: (message: string) => void;
}

export function usePlatformLocalStoreResources({
  authorized,
  apiAvailable,
  rootRole,
  setup,
  domains,
  onNotice,
}: UsePlatformLocalStoreResourcesOptions): PlatformLocalStoreController {
  const [organizations, setOrganizations] = useState<
    LocalStoreResourceState<SubplatformOrganizationRecord[]>
  >({ status: "loading" });
  const [mutation, setMutation] = useState<
    "registration" | "activation" | null
  >(null);
  const [operationPhase, setOperationPhase] = useState("");
  const [registrationCancellable, setRegistrationCancellable] = useState(false);
  const mountedRef = useRef(false);
  const requestVersionRef = useRef(0);
  const runGenerationRef = useRef(0);
  const activeRunRef = useRef<number | null>(null);
  const mutationRef = useRef<"registration" | "activation" | null>(null);
  const registrationCancellableRef = useRef(false);
  const stateRef = useRef({ organizations });
  const contextRef = useRef({
    authorized,
    apiAvailable,
    rootRole,
    setup,
    domains,
  });
  stateRef.current = { organizations };
  contextRef.current = {
    authorized,
    apiAvailable,
    rootRole,
    setup,
    domains,
  };

  const refreshOrganizations = useCallback(async () => {
    const requestVersion = ++requestVersionRef.current;
    setOrganizations((current) => loadingState(current));
    try {
      const data = await getSubplatformOrganizations();
      if (mountedRef.current && requestVersionRef.current === requestVersion)
        setOrganizations({ status: "ready", data });
    } catch (error) {
      if (mountedRef.current && requestVersionRef.current === requestVersion) {
        setOrganizations((current) =>
          errorState(current, errorMessage(error, "本地店铺读取失败")),
        );
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (!authorized || !apiAvailable) {
      requestVersionRef.current += 1;
      const message = authorized
        ? "当前部署未启用商城管理 API"
        : "当前账号无权读取本地店铺";
      setOrganizations((current) => errorState(current, message));
    } else {
      void refreshOrganizations();
    }
    return () => {
      mountedRef.current = false;
      requestVersionRef.current += 1;
      runGenerationRef.current += 1;
    };
  }, [apiAvailable, authorized, refreshOrganizations]);

  const retryFailed = useCallback(async () => {
    const context = contextRef.current;
    if (
      context.authorized &&
      context.apiAvailable &&
      stateRef.current.organizations.status === "error"
    ) {
      await refreshOrganizations();
    }
  }, [refreshOrganizations]);

  const cancelRegistration = useCallback((): boolean => {
    if (mutationRef.current === "activation") return false;
    if (
      mutationRef.current === "registration" &&
      !registrationCancellableRef.current
    ) {
      return false;
    }
    runGenerationRef.current += 1;
    activeRunRef.current = null;
    if (mutationRef.current === "registration") mutationRef.current = null;
    registrationCancellableRef.current = false;
    if (mountedRef.current) {
      setMutation(null);
      setRegistrationCancellable(false);
      setOperationPhase("");
    }
    return true;
  }, []);

  const commitRegistration = useCallback(
    async (draft: LocalStoreRegistrationDraft): Promise<boolean> => {
      if (mutationRef.current) return false;
      const initialAuthority = writableLocalStoreAuthority(
        contextRef.current,
        draft.domainId,
        onNotice,
      );
      if (!initialAuthority) return false;
      if (stateRef.current.organizations.status !== "ready") {
        onNotice("本地店铺状态尚未验证，请重新读取后再登记");
        return false;
      }
      if (draft.updateOrganizationId) {
        const currentOrganization = currentUpdateOrganization(
          stateRef.current.organizations.data,
          draft.updateOrganizationId,
          initialAuthority,
          onNotice,
        );
        if (!currentOrganization) return false;
        if (currentOrganization.sourceKind !== draft.sourceKind) {
          onNotice("店铺来源类型已变化，请重新读取后再更新");
          return false;
        }
      }
      if (draft.sourceKind === "git" && !validGitLocator(draft.sourceLocator)) {
        onNotice("请填写不含凭据的 Git HTTPS 地址");
        return false;
      }
      if (draft.sourceKind === "archive" && !draft.archive) {
        onNotice("请选择 .tar.gz、.tgz、.tar.zst 或 .tzst 店铺接入包");
        return false;
      }

      const run = ++runGenerationRef.current;
      activeRunRef.current = run;
      mutationRef.current = "registration";
      registrationCancellableRef.current = true;
      setMutation("registration");
      setRegistrationCancellable(true);
      setOperationPhase("正在准备店铺来源…");
      const isCurrent = () =>
        mountedRef.current && runGenerationRef.current === run;
      try {
        let sourceLocator = draft.sourceLocator.trim();
        let sourceDigest = "";
        let pinnedRevision = "";
        if (draft.sourceKind === "archive") {
          const uploaded = await uploadSubplatformArchive(
            draft.archive as File,
            initialAuthority.organizationId,
          );
          if (!isCurrent()) return false;
          sourceLocator = uploaded.sourceLocator;
          sourceDigest = uploaded.sourceDigest.toLowerCase();
          pinnedRevision = sourceDigest;
        }

        if (isCurrent()) setOperationPhase("正在提交到隔离构建器…");
        const intake = await discoverSubplatformSource({
          domainId: draft.domainId,
          parentOrganizationId: initialAuthority.organizationId,
          sourceKind: draft.sourceKind,
          sourceLocator,
          sourceDigest: sourceDigest || undefined,
          requestedScopes: draft.requestedScopes?.length
            ? draft.requestedScopes
            : undefined,
          membershipPolicy: draft.membershipPolicy,
        });
        if (!isCurrent()) return false;

        let discovered = null;
        for (let attempt = 0; attempt < 90; attempt += 1) {
          discovered = await getSubplatformSourceIntake(intake.intakeId);
          if (!isCurrent()) return false;
          if (discovered.state === "ready") break;
          if (discovered.state === "rejected")
            throw new Error(discovered.error || "隔离构建器拒绝了这个店铺来源");
          setOperationPhase(
            discovered.state === "discovering"
              ? "隔离构建器正在读取 manifest…"
              : "等待隔离构建器接单…",
          );
          await localStorePollDelay();
          if (!isCurrent()) return false;
        }
        if (!discovered || discovered.state !== "ready")
          throw new Error(
            `隔离构建器尚未完成，请稍后重试（任务 ${intake.intakeId}）`,
          );
        const registration = registrationFromDiscovery(
          discovered,
          sourceDigest,
          pinnedRevision,
        );

        const finalAuthority = writableLocalStoreAuthority(
          contextRef.current,
          draft.domainId,
          onNotice,
        );
        if (!isCurrent() || !finalAuthority) return false;
        if (
          finalAuthority.tenantId !== initialAuthority.tenantId ||
          finalAuthority.organizationId !== initialAuthority.organizationId ||
          finalAuthority.domain.id !== initialAuthority.domain.id
        ) {
          onNotice("商城租户或根组织已变化，请重新读取后再接入店铺");
          return false;
        }
        const currentOrganizations = stateRef.current.organizations;
        if (currentOrganizations.status !== "ready") {
          onNotice("本地店铺状态已变化，请重新读取后再登记");
          return false;
        }
        if (draft.updateOrganizationId) {
          const currentOrganization = currentUpdateOrganization(
            currentOrganizations.data,
            draft.updateOrganizationId,
            finalAuthority,
            onNotice,
          );
          if (!currentOrganization) return false;
          if (currentOrganization.sourceKind !== draft.sourceKind) {
            onNotice("店铺来源类型已变化，请重新读取后再更新");
            return false;
          }
        }

        registrationCancellableRef.current = false;
        setRegistrationCancellable(false);
        setOperationPhase("manifest 已验证，正在登记店铺…");
        const result = await registerSubplatform({
          tenantId: finalAuthority.tenantId,
          domainId: finalAuthority.domain.id,
          parentOrganizationId: finalAuthority.organizationId,
          packageId: registration.packageId,
          slug: registration.slug,
          sourceKind: draft.sourceKind,
          sourceLocator,
          pinnedRevision: registration.pinnedRevision,
          sourceDigest: registration.sourceDigest,
          manifest: registration.manifest,
          requestedScopes: draft.requestedScopes?.length
            ? draft.requestedScopes
            : undefined,
          membershipPolicy: draft.membershipPolicy,
        });
        if (!isCurrent()) return false;
        setOperationPhase("");
        onNotice(`店铺 ${result.slug} 已登记，等待隔离构建器完成构建`);
        return true;
      } catch (error) {
        if (!isCurrent()) return false;
        const message = errorMessage(error, "店铺接入失败");
        setOperationPhase(message);
        onNotice(message);
        return false;
      } finally {
        if (activeRunRef.current === run) {
          activeRunRef.current = null;
          mutationRef.current = null;
          registrationCancellableRef.current = false;
          if (mountedRef.current) {
            setMutation(null);
            setRegistrationCancellable(false);
          }
        }
      }
    },
    [onNotice],
  );

  const commitActivation = useCallback(
    async (organizationId: string): Promise<boolean> => {
      if (mutationRef.current) return false;
      const context = contextRef.current;
      const current = stateRef.current.organizations;
      if (current.status !== "ready") {
        onNotice("本地店铺状态尚未验证，请重新读取后再上线");
        return false;
      }
      const organization = current.data.find(
        (item) => item.id === organizationId,
      );
      const authority = organization?.domainId
        ? writableLocalStoreAuthority(context, organization.domainId, onNotice)
        : null;
      if (
        !organization ||
        !authority ||
        !currentActivatableOrganization(organization, authority, onNotice)
      ) {
        return false;
      }

      mutationRef.current = "activation";
      setMutation("activation");
      try {
        await activateSubplatform({
          registrationId: organization.registrationId as string,
          buildDigest: organization.buildDigest as string,
        });
        onNotice(`${organization.name} 已激活并加入平台路由`);
        return true;
      } catch (error) {
        onNotice(errorMessage(error, "店铺启用失败"));
        return false;
      } finally {
        mutationRef.current = null;
        if (mountedRef.current) setMutation(null);
      }
    },
    [onNotice],
  );

  const prepareUpdate = useCallback(
    (organizationId: string): LocalStoreUpdateSeed | null => {
      const current = stateRef.current.organizations;
      if (current.status !== "ready") {
        onNotice("本地店铺状态尚未验证，请重新读取后再更新");
        return null;
      }
      const organization = current.data.find(
        (item) => item.id === organizationId,
      );
      const authority = organization?.domainId
        ? writableLocalStoreAuthority(
            contextRef.current,
            organization.domainId,
            onNotice,
          )
        : null;
      if (
        !organization ||
        !authority ||
        !currentUpdateOrganization(
          current.data,
          organizationId,
          authority,
          onNotice,
        )
      ) {
        return null;
      }
      return {
        organizationId,
        sourceKind: organization.sourceKind as "git" | "archive",
        domainId: organization.domainId as string,
        sourceLocator:
          organization.sourceKind === "git"
            ? organization.sourceLocator || organization.sourceRepository || ""
            : "",
        name: organization.name,
      };
    },
    [onNotice],
  );

  return {
    organizations,
    mutation,
    operationPhase,
    registrationCancellable,
    writeBlockReason: localStoreWriteBlockReason(contextRef.current),
    retryAvailable: authorized && apiAvailable,
    retryFailed,
    refreshOrganizations,
    cancelRegistration,
    commitRegistration,
    commitActivation,
    prepareUpdate,
  };
}

export function localStoreResourceData<T>(
  state: LocalStoreResourceState<T>,
): T | undefined {
  return state.status === "ready" ? state.data : state.previous;
}

function loadingState<T>(
  current: LocalStoreResourceState<T>,
): LocalStoreResourceState<T> {
  const previous = localStoreResourceData(current);
  return previous === undefined
    ? { status: "loading" }
    : { status: "loading", previous };
}

function errorState<T>(
  current: LocalStoreResourceState<T>,
  message: string,
): LocalStoreResourceState<T> {
  const previous = localStoreResourceData(current);
  return previous === undefined
    ? { status: "error", message }
    : { status: "error", message, previous };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

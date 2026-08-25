"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  loadSubplatform,
  resolveSubplatform,
  type SubplatformConfig,
} from "../subplatform";
import type { WorkspaceRole } from "../types";
import { requiresAuthenticatedWorkspace } from "./useAuthSession";

export type AccountSettingsSection = "profile" | "account" | "stores";

export function roleFromLocation(): WorkspaceRole {
  if (typeof window === "undefined") return "buyer";
  const requested = new URLSearchParams(window.location.search).get("role");
  return requested === "platform" ? requested : "buyer";
}

export function relativeBrowserLocation(searchParams: URLSearchParams): string {
  const query = searchParams.toString();
  return `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
}

export function parentPlatformHref(path: string, role: WorkspaceRole): string {
  void path;
  return role === "buyer" ? "/" : `/?role=${encodeURIComponent(role)}`;
}

export function requestedStoreConsoleSection(): "products" | "customers" {
  if (typeof window === "undefined") return "products";
  return new URLSearchParams(window.location.search).get(
    "storeConsoleSection",
  ) === "customers"
    ? "customers"
    : "products";
}

export function roleLabel(
  role: WorkspaceRole,
  locale: "zh" | "en",
  subplatform?: SubplatformConfig,
): string {
  void subplatform;
  if (locale === "en") {
    return role === "buyer" ? "Account" : "Mall operator";
  }
  return role === "buyer" ? "统一账号" : "商城运营";
}

export function appCopy(locale: "zh" | "en") {
  if (locale === "en") {
    return {
      skipToContent: "Skip to content",
      backToParent: "Back to mall",
      rootPlatform: "Mall",
      myStores: "My stores",
      openStore: "Open a store",
      storeCenter: "My stores",
      myStoresDescription:
        "See every store you own or help run, then browse it or manage its products.",
      closeMyStores: "Close my stores",
      closeMyStoresDialog: "Close my stores dialog",
      manageStore: "Manage this store",
      closeStoreConsole: "Close store management",
      closeStoreConsoleDialog: "Close store management dialog",
      account: "Account",
      accountMenu: "Account menu",
      accountDescription:
        "Manage your password, passkeys, identity bindings, and signed-in devices.",
      profile: "Profile",
      profileDescription: "Choose your avatar and introduce yourself.",
      contact: "Contact details",
      contactDescription:
        "Set the buyer contact channels that can be shared only after mutual consent.",
      closeContact: "Close contact details",
      closeContactDialog: "Close contact details dialog",
      closeProfile: "Close profile",
      closeProfileDialog: "Close profile dialog",
      closeAccount: "Close account",
      closeAccountDialog: "Close account dialog",
      appearance: "Display & language",
      workspace: "Workspace",
      signIn: "Sign in",
      user: "MatchPlane user",
      unifiedIdentity: "Unified identity",
      subplatformAdmin: "Store console",
      platformAdmin: "Mall console",
      signOut: "Sign out",
      signedOut: "Signed out",
      signOutFailed: "Could not sign out. Try again.",
    };
  }
  return {
    skipToContent: "跳到主要内容",
    backToParent: "返回商城",
    rootPlatform: "商城首页",
    myStores: "我的店铺",
    openStore: "开一家店",
    storeCenter: "我的店铺",
    myStoresDescription:
      "查看你拥有或参与运营的全部店铺，再进入浏览或直接管理商品。",
    closeMyStores: "关闭我的店铺",
    closeMyStoresDialog: "关闭我的店铺对话框",
    manageStore: "管理这家店",
    closeStoreConsole: "关闭店铺管理",
    closeStoreConsoleDialog: "关闭店铺管理对话框",
    account: "账号",
    accountMenu: "账号菜单",
    accountDescription: "管理密码、通行密钥、身份绑定和登录设备。",
    profile: "个人资料",
    profileDescription: "设置头像和个人简介。",
    contact: "联系方式",
    contactDescription: "设置买家自己的联系方式；只有双方同意后才会交换。",
    closeContact: "关闭联系方式",
    closeContactDialog: "关闭联系方式对话框",
    closeProfile: "关闭个人资料",
    closeProfileDialog: "关闭个人资料对话框",
    closeAccount: "关闭账号",
    closeAccountDialog: "关闭账号对话框",
    appearance: "显示与语言",
    workspace: "工作台",
    signIn: "登录",
    user: "MatchPlane 用户",
    unifiedIdentity: "已登录的统一身份",
    subplatformAdmin: "店铺控制台",
    platformAdmin: "商城控制台",
    signOut: "退出登录",
    signedOut: "已退出当前账号",
    signOutFailed: "退出登录失败，请稍后重试",
  };
}

interface UseSubplatformRouteOptions {
  initialPath?: string;
  authResolved: boolean;
}

export function useSubplatformRoute({
  initialPath = "/",
  authResolved,
}: UseSubplatformRouteOptions) {
  const [role, setRole] = useState<WorkspaceRole>("buyer");
  const [subplatform, setSubplatform] = useState<SubplatformConfig>(() =>
    resolveSubplatform(initialPath),
  );
  const [hydrated, setHydrated] = useState(false);
  const [accountSettingsSection, setAccountSettingsSection] =
    useState<AccountSettingsSection | null>(null);
  const [storeConsoleRequested, setStoreConsoleRequested] = useState(false);

  const requestedRoleRef = useRef<WorkspaceRole>(roleFromLocation());
  const navigationRequestRef = useRef(0);

  const navigateToSubplatform = useCallback(
    async (target: string): Promise<SubplatformConfig> => {
      const destination = new URL(target, window.location.origin);
      if (
        destination.origin !== window.location.origin ||
        !destination.pathname.startsWith("/")
      ) {
        throw new Error("平台入口必须使用本站路径");
      }

      const request = navigationRequestRef.current + 1;
      navigationRequestRef.current = request;
      const path = destination.pathname;
      const fallback = resolveSubplatform(path);
      window.history.pushState(null, "", path);
      setSubplatform(fallback);

      try {
        const loaded = await loadSubplatform(path);
        if (navigationRequestRef.current === request) setSubplatform(loaded);
        return loaded;
      } catch {
        return fallback;
      }
    },
    [],
  );

  useEffect(() => {
    const requestedPath = window.location.pathname;
    const searchParams = new URLSearchParams(window.location.search);
    const accountTarget = searchParams.get("account");
    let cleanWorkspaceTarget = false;

    if (accountTarget === "identity") {
      setAccountSettingsSection("account");
      searchParams.delete("account");
      cleanWorkspaceTarget = true;
    }
    if (accountTarget === "profile") {
      setAccountSettingsSection("profile");
      searchParams.delete("account");
      cleanWorkspaceTarget = true;
    }
    if (searchParams.get("stores") === "1") {
      setAccountSettingsSection("stores");
      searchParams.delete("stores");
      cleanWorkspaceTarget = true;
    }
    if (searchParams.get("console") === "products") {
      setStoreConsoleRequested(true);
      searchParams.delete("console");
      cleanWorkspaceTarget = true;
    }
    if (searchParams.has("publish")) {
      searchParams.delete("publish");
      cleanWorkspaceTarget = true;
    }
    if (cleanWorkspaceTarget) {
      window.history.replaceState(
        null,
        "",
        relativeBrowserLocation(searchParams),
      );
    }
    setSubplatform(resolveSubplatform(requestedPath));
    void loadSubplatform(requestedPath).then(setSubplatform);
    const requestedRole = roleFromLocation();
    requestedRoleRef.current = requestedRole;
    setRole(
      requiresAuthenticatedWorkspace(requestedRole) ? "buyer" : requestedRole,
    );
    setHydrated(true);

    const onPopState = () => {
      const path = window.location.pathname;
      const request = navigationRequestRef.current + 1;
      navigationRequestRef.current = request;
      setSubplatform(resolveSubplatform(path));
      void loadSubplatform(path).then((loaded) => {
        if (navigationRequestRef.current === request) setSubplatform(loaded);
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!hydrated || !authResolved) return;
    const searchParams = new URLSearchParams(window.location.search);
    if (role === "buyer") searchParams.delete("role");
    else searchParams.set("role", role);
    window.history.replaceState(
      null,
      "",
      relativeBrowserLocation(searchParams),
    );
  }, [authResolved, hydrated, role]);

  // In-page requests (for example the contact consent card) open the account
  // bindings dialog without a full navigation, so an ongoing chat is not lost.
  useEffect(() => {
    const openAccountBindings = (event: Event) => {
      event.preventDefault();
      setAccountSettingsSection("account");
    };
    window.addEventListener("matchplane.account.bindings", openAccountBindings);
    return () =>
      window.removeEventListener(
        "matchplane.account.bindings",
        openAccountBindings,
      );
  }, []);

  return {
    role,
    setRole,
    subplatform,
    setSubplatform,
    hydrated,
    accountSettingsSection,
    setAccountSettingsSection,
    storeConsoleRequested,
    setStoreConsoleRequested,
    navigateToSubplatform,
    requestedRoleRef,
  };
}

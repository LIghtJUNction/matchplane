import type {
  PlatformDomainRecord,
  SubplatformOrganizationRecord,
  SubplatformSourceIntake,
} from "../api";
import type {
  PlatformDomainsResourceState,
  PlatformSetupResourceState,
} from "./usePlatformBootstrapResources";

export interface LocalStoreAuthorityContext {
  authorized: boolean;
  apiAvailable: boolean;
  rootRole?: string | null;
  setup: PlatformSetupResourceState;
  domains: PlatformDomainsResourceState;
}

export interface WritableLocalStoreAuthority {
  tenantId: string;
  organizationId: string;
  domain: PlatformDomainRecord;
}

export function localStoreWriteBlockReason(
  context: LocalStoreAuthorityContext,
): string | null {
  if (
    !context.authorized ||
    (context.rootRole !== "rootAdmin" && context.rootRole !== "rootSuperAdmin")
  )
    return "当前账号无权修改本地店铺";
  if (!context.apiAvailable) return "当前部署未启用商城管理 API";
  if (context.setup.status !== "ready") return "商城初始化状态尚未验证";
  if (
    !context.setup.data.root.tenantId ||
    !context.setup.data.root.organization?.id
  )
    return "商城已确认尚未完成初始化";
  if (context.domains.status !== "ready") return "商城数据范围尚未验证";
  if (!context.domains.data.some((domain) => domain.status === "active"))
    return "商城数据尚未准备好";
  return null;
}

export function writableLocalStoreAuthority(
  context: LocalStoreAuthorityContext,
  domainId: string,
  onNotice: (message: string) => void,
): WritableLocalStoreAuthority | null {
  const reason = localStoreWriteBlockReason(context);
  if (reason) {
    onNotice(reason);
    return null;
  }
  if (context.setup.status !== "ready" || context.domains.status !== "ready")
    return null;
  const domain = context.domains.data.find(
    (item) => item.id === domainId && item.status === "active",
  );
  if (!domain) {
    onNotice("请选择一个当前已验证的商城数据范围");
    return null;
  }
  return {
    tenantId: context.setup.data.root.tenantId as string,
    organizationId: context.setup.data.root.organization?.id as string,
    domain,
  };
}

export function currentUpdateOrganization(
  organizations: SubplatformOrganizationRecord[],
  organizationId: string,
  authority: WritableLocalStoreAuthority,
  onNotice: (message: string) => void,
): SubplatformOrganizationRecord | null {
  const organization = organizations.find((item) => item.id === organizationId);
  if (
    !organization ||
    organization.registrationState !== "active" ||
    (organization.sourceKind !== "git" &&
      organization.sourceKind !== "archive") ||
    organization.domainId !== authority.domain.id ||
    organization.tenantId !== authority.tenantId
  ) {
    onNotice("店铺状态、来源或数据范围已变化，请重新读取后再更新");
    return null;
  }
  return organization;
}

export function currentActivatableOrganization(
  organization: SubplatformOrganizationRecord,
  authority: WritableLocalStoreAuthority,
  onNotice: (message: string) => void,
): boolean {
  if (
    organization.registrationState !== "ready" ||
    !organization.registrationId ||
    !organization.buildDigest ||
    (organization.sourceKind !== "git" &&
      organization.sourceKind !== "archive") ||
    organization.domainId !== authority.domain.id ||
    organization.tenantId !== authority.tenantId
  ) {
    onNotice("店铺登记状态、构建凭据、来源或数据范围已变化，请重新读取");
    return false;
  }
  return true;
}

export function registrationFromDiscovery(
  discovered: Pick<
    SubplatformSourceIntake,
    "manifest" | "packageId" | "slug" | "sourceDigest" | "pinnedRevision"
  >,
  fallbackDigest: string,
  fallbackRevision: string,
) {
  const manifest = discovered.manifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new Error("隔离构建器没有返回有效 manifest");
  const packageId = discovered.packageId || String(manifest.id || "");
  const slug = discovered.slug || String(manifest.slug || "");
  const sourceDigest = discovered.sourceDigest?.toLowerCase() || fallbackDigest;
  const pinnedRevision =
    discovered.pinnedRevision?.toLowerCase() || fallbackRevision;
  if (!/^[a-z0-9][a-z0-9._-]{1,127}$/.test(packageId))
    throw new Error("package id 只能使用小写字母、数字、点、下划线或短横线");
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug))
    throw new Error("slug 只能使用小写字母、数字和短横线");
  if (manifest.id !== packageId || manifest.slug !== slug)
    throw new Error("构建器返回的 manifest.id/slug 与店铺不一致");
  if (!/^[0-9a-f]{7,128}$/i.test(pinnedRevision))
    throw new Error("pinned revision 必须是不可变的 commit 或 digest");
  if (!/^[0-9a-f]{64}$/i.test(sourceDigest))
    throw new Error(
      "source digest 必须是 64 位 SHA-256；不要提交未经验证的来源",
    );
  return { manifest, packageId, slug, sourceDigest, pinnedRevision };
}

export function validGitLocator(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function localStorePollDelay(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 2_000));
}

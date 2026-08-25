"use client";

import {
  AlertTriangle,
  Archive,
  GitBranch,
  RefreshCw,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { PlatformDomainsResourceState } from "../hooks/usePlatformBootstrapResources";
import {
  localStoreResourceData,
  type PlatformLocalStoreController,
} from "../hooks/usePlatformLocalStoreResources";

interface PlatformLocalStorePanelProps {
  controller: PlatformLocalStoreController;
  domainsResource: PlatformDomainsResourceState;
  hidden?: boolean;
  onNotice: (message: string) => void;
}

export function PlatformLocalStorePanel({
  controller,
  domainsResource,
  hidden = false,
  onNotice,
}: PlatformLocalStorePanelProps) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [sourceKind, setSourceKind] = useState<"git" | "archive">("git");
  const [domainId, setDomainId] = useState("");
  const [sourceLocator, setSourceLocator] = useState("");
  const [archive, setArchive] = useState<File | null>(null);
  const [updateOrganizationId, setUpdateOrganizationId] = useState<
    string | undefined
  >();
  const sawFreshDomainsRef = useRef(false);
  const displayedOrganizations = localStoreResourceData(
    controller.organizations,
  );
  const localOrganizations = useMemo(
    () =>
      displayedOrganizations?.filter(
        (organization) =>
          organization.sourceKind === "git" ||
          organization.sourceKind === "archive",
      ) ?? [],
    [displayedOrganizations],
  );
  const freshDomainData =
    domainsResource.status === "ready" ? domainsResource.data : null;
  const freshDomains = useMemo(
    () =>
      freshDomainData?.filter((domain) => domain.status === "active") ?? null,
    [freshDomainData],
  );
  const running = controller.mutation === "registration";
  const registrationLocked = running && !controller.registrationCancellable;
  const canOpen =
    !controller.writeBlockReason && controller.organizations.status === "ready";
  const selectedDomain = freshDomains?.find((domain) => domain.id === domainId);

  useEffect(() => {
    const isFirstFreshResult =
      freshDomains !== null && !sawFreshDomainsRef.current;
    if (freshDomains !== null) sawFreshDomainsRef.current = true;
    setDomainId((current) => {
      if (current && !freshDomains?.some((domain) => domain.id === current))
        return "";
      if (!current && isFirstFreshResult && freshDomains?.length === 1)
        return freshDomains[0]?.id ?? "";
      return current;
    });
  }, [freshDomains]);

  const resetEditor = () => {
    setSourceKind("git");
    setSourceLocator("");
    setArchive(null);
    setUpdateOrganizationId(undefined);
  };

  const closeEditor = () => {
    if (!controller.cancelRegistration()) return;
    setEditorOpen(false);
    resetEditor();
  };

  const submitRegistration = async () => {
    if (!selectedDomain) {
      onNotice("请选择一个当前已验证的商城数据范围");
      return;
    }
    if (sourceKind === "git" && !sourceLocator.trim()) {
      onNotice("请填写不含凭据的 Git HTTPS 地址");
      return;
    }
    if (sourceKind === "archive" && !archive) {
      onNotice("请选择 .tar.gz、.tgz、.tar.zst 或 .tzst 店铺接入包");
      return;
    }
    const committed = await controller.commitRegistration({
      sourceKind,
      domainId: selectedDomain.id,
      sourceLocator: sourceLocator.trim(),
      archive,
      membershipPolicy: "public",
      updateOrganizationId,
    });
    if (!committed) return;
    setEditorOpen(false);
    resetEditor();
    await controller.refreshOrganizations();
  };

  const activate = async (organizationId: string) => {
    if (await controller.commitActivation(organizationId))
      await controller.refreshOrganizations();
  };

  const update = (organizationId: string) => {
    const seed = controller.prepareUpdate(organizationId);
    if (!seed) return;
    setUpdateOrganizationId(seed.organizationId);
    setSourceKind(seed.sourceKind);
    setDomainId(seed.domainId);
    setSourceLocator(seed.sourceLocator);
    setArchive(null);
    setEditorOpen(true);
  };

  return (
    <section
      id="platform-panel-tree"
      className="surface subplatform-panel"
      role="tabpanel"
      aria-labelledby="platform-tab-tree"
      hidden={hidden}
    >
      <LocalStoreNotice controller={controller} />
      {controller.writeBlockReason && displayedOrganizations !== undefined ? (
        <p className="local-store-status" role="status">
          {controller.writeBlockReason}
        </p>
      ) : null}
      <div className="subplatform-header">
        <div>
          <h2 id="subplatform-title">本地店铺</h2>
          <p className="subplatform-intro">
            从 Git 仓库或压缩包下载、构建并托管在商城服务器上的店铺。
          </p>
        </div>
        <button
          className="button button-dark"
          type="button"
          disabled={
            editorOpen
              ? registrationLocked || controller.mutation === "activation"
              : controller.mutation !== null || !canOpen
          }
          title={
            !canOpen && !editorOpen
              ? (controller.writeBlockReason ?? undefined)
              : undefined
          }
          onClick={() => (editorOpen ? closeEditor() : setEditorOpen(true))}
        >
          {editorOpen
            ? running
              ? controller.registrationCancellable
                ? "取消"
                : "登记中…"
              : "关闭"
            : "接入本地店铺"}
        </button>
      </div>

      {resourceStaleText(controller) ? (
        <p className="local-store-stale" role="status">
          {resourceStaleText(controller)}
        </p>
      ) : null}

      {localOrganizations.length ? (
        <div className="subplatform-list" aria-label="本地店铺列表">
          {localOrganizations.map((organization) => (
            <div className="subplatform-row" key={organization.id}>
              <span className="subplatform-row-icon" aria-hidden="true">
                <Archive size={18} />
              </span>
              <span className="subplatform-row-copy">
                <strong>{organization.name}</strong>
                <small>
                  /{organization.slug} ·{" "}
                  {organization.sourceKind === "git"
                    ? "Git 本地部署"
                    : "压缩包本地部署"}
                </small>
              </span>
              <span
                className={`subplatform-state state-${organization.registrationState || "unknown"}`}
              >
                {stateLabel(organization.registrationState)}
              </span>
              {organization.buildError ? (
                <small
                  className="subplatform-build-error"
                  title={organization.buildError}
                >
                  最近失败：{organization.buildError.slice(0, 120)}
                </small>
              ) : null}
              {organization.registrationState === "ready" &&
              organization.buildDigest ? (
                <button
                  className="button button-dark subplatform-activate"
                  type="button"
                  disabled={
                    controller.mutation !== null ||
                    controller.organizations.status !== "ready"
                  }
                  onClick={() => void activate(organization.id)}
                >
                  上线店铺
                </button>
              ) : null}
              {organization.registrationState === "active" ? (
                <button
                  className="button button-light subplatform-activate"
                  type="button"
                  disabled={
                    controller.mutation !== null ||
                    controller.organizations.status !== "ready"
                  }
                  onClick={() => update(organization.id)}
                >
                  {organization.sourceKind === "git"
                    ? "检查更新"
                    : "上传新版本"}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : controller.organizations.status === "ready" ? (
        <div className="subplatform-empty">
          <GitBranch size={22} aria-hidden="true" />
          <p>还没有本地店铺。</p>
        </div>
      ) : null}

      {editorOpen ? (
        <form
          className="admin-editor subplatform-editor"
          aria-label="接入本地店铺"
          onSubmit={(event) => {
            event.preventDefault();
            void submitRegistration();
          }}
        >
          <div className="admin-editor-heading">
            <div>
              <strong>
                {updateOrganizationId ? "更新本地店铺" : "接入本地店铺"}
              </strong>
              <small>
                填写 Git 地址或上传压缩包，商城会在本地构建并托管它。
              </small>
            </div>
            <button
              type="button"
              disabled={registrationLocked}
              onClick={closeEditor}
            >
              {running
                ? controller.registrationCancellable
                  ? "取消"
                  : "登记中…"
                : "关闭"}
            </button>
          </div>
          <div
            className="subplatform-source-switch"
            role="group"
            aria-label="本地店铺来源"
          >
            <button
              type="button"
              disabled={running || Boolean(updateOrganizationId)}
              className={sourceKind === "git" ? "is-selected" : ""}
              aria-pressed={sourceKind === "git"}
              onClick={() => {
                setSourceKind("git");
                setArchive(null);
              }}
            >
              <GitBranch size={16} aria-hidden="true" />
              Git 仓库
            </button>
            <button
              type="button"
              disabled={running || Boolean(updateOrganizationId)}
              className={sourceKind === "archive" ? "is-selected" : ""}
              aria-pressed={sourceKind === "archive"}
              onClick={() => {
                setSourceKind("archive");
                setSourceLocator("");
              }}
            >
              <Upload size={16} aria-hidden="true" />
              上传压缩包
            </button>
          </div>
          <div className="subplatform-form-grid">
            <label className="subplatform-form-wide">
              <span>商城数据范围</span>
              <select
                required
                value={domainId}
                disabled={running || domainsResource.status !== "ready"}
                onChange={(event) => setDomainId(event.target.value)}
              >
                <option value="">明确选择数据范围</option>
                {(freshDomains ?? []).map((domain) => (
                  <option key={domain.id} value={domain.id}>
                    {domain.name} · /{domain.slug}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {sourceKind === "git" ? (
            <div className="subplatform-form-grid">
              <label className="subplatform-form-wide">
                <span>Git HTTPS 地址（不含凭据）</span>
                <input
                  required
                  type="url"
                  value={sourceLocator}
                  disabled={running}
                  onChange={(event) => setSourceLocator(event.target.value)}
                  placeholder="https://github.com/example/market.git"
                />
              </label>
            </div>
          ) : (
            <div className="subplatform-upload-box">
              <label className="file-picker">
                <Upload size={18} aria-hidden="true" />
                <span>{archive?.name || "选择本地店铺压缩包"}</span>
                <input
                  required
                  type="file"
                  disabled={running}
                  accept=".tar.gz,.tgz,.tar.zst,.tzst"
                  onChange={(event) =>
                    setArchive(event.target.files?.[0] ?? null)
                  }
                />
              </label>
              <p>
                限制 64 MiB；服务端只保存随机
                locator，隔离构建器负责解包与验证。
              </p>
            </div>
          )}
          <div className="subplatform-editor-footer">
            <p>
              <ShieldCheck size={16} aria-hidden="true" />
              本地店铺通过隔离构建与校验后上线。
            </p>
            {controller.operationPhase ? (
              <small className="subplatform-discovery-state" role="status">
                {controller.operationPhase}
              </small>
            ) : null}
            <button
              className="button button-dark"
              type="submit"
              disabled={
                controller.mutation !== null ||
                !canOpen ||
                !selectedDomain ||
                (sourceKind === "git" ? !sourceLocator.trim() : !archive)
              }
            >
              {running ? "处理中…" : "构建本地店铺"}
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function LocalStoreNotice({
  controller,
}: Pick<PlatformLocalStorePanelProps, "controller">) {
  if (controller.organizations.status === "error") {
    return (
      <div className="local-store-alert" role="alert">
        <AlertTriangle aria-hidden="true" size={18} />
        <div>
          <strong>本地店铺暂时不可用</strong>
          <p>{controller.organizations.message}</p>
        </div>
        <button
          className="button button-light button-small"
          type="button"
          disabled={!controller.retryAvailable}
          onClick={() => void controller.retryFailed()}
        >
          <RefreshCw aria-hidden="true" size={14} />
          重新读取
        </button>
      </div>
    );
  }
  return controller.organizations.status === "loading" ? (
    <p className="local-store-status" role="status">
      正在验证本地店铺；上次结果如有将保持只读。
    </p>
  ) : null;
}

function resourceStaleText(
  controller: PlatformLocalStoreController,
): string | null {
  const resource = controller.organizations;
  if (resource.status === "ready" || resource.previous === undefined)
    return null;
  return resource.status === "loading"
    ? "本地店铺正在重新验证；当前展示上次结果。"
    : "本地店铺当前待验证；仅展示上次结果，登记、更新和上线均已暂停。";
}

function stateLabel(state: string | null): string {
  return (
    {
      active: "已激活",
      ready: "构建完成",
      building: "构建中",
      validated: "已登记，待构建",
      rejected: "构建失败",
    }[state || ""] || "未登记"
  );
}

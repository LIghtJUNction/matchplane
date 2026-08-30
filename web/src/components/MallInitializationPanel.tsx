import type { PlatformAiStatus, PlatformSetupStatus } from "../api";
import type {
  PlatformAiResourceState,
  PlatformDomainsResourceState,
  PlatformSetupResourceState,
} from "../hooks/usePlatformBootstrapResources";
import { bootstrapResourceData } from "../hooks/usePlatformBootstrapResources";

interface MallInitializationPanelProps {
  setupResource: PlatformSetupResourceState;
  domainsResource: PlatformDomainsResourceState;
  aiResource: PlatformAiResourceState;
  rootRole?: string | null;
  saving: boolean;
  onInitializeRoot: () => void;
  onOpenStores: (openScope: boolean) => void;
  onOpenSettings: () => void;
  onOpenAi: () => void;
}

export function MallInitializationPanel({
  setupResource,
  domainsResource,
  aiResource,
  rootRole,
  saving,
  onInitializeRoot,
  onOpenStores,
  onOpenSettings,
  onOpenAi,
}: MallInitializationPanelProps) {
  const displaySetup = bootstrapResourceData(setupResource);
  const displayAi = bootstrapResourceData(aiResource);
  const verifiedSetup =
    setupResource.status === "ready" ? setupResource.data : null;
  const verifiedDomains =
    domainsResource.status === "ready" ? domainsResource.data : null;
  const verifiedAi = aiResource.status === "ready" ? aiResource.data : null;
  const rootReady = Boolean(verifiedSetup?.root.organization);
  const scopeReady = Boolean(verifiedDomains?.length);
  const firstStoreReady = (verifiedSetup?.routing.activeChildren ?? 0) > 0;
  const aiReady = verifiedAi?.router.configured === true;
  const nextStep =
    setupResource.status === "ready"
      ? rootReady
        ? domainsResource.status === "ready"
          ? scopeReady
            ? aiResource.status === "ready"
              ? aiReady
                ? firstStoreReady
                  ? "检查商城设置"
                  : "接入第一家店铺"
                : "连接模型服务"
              : "确认 AI 导购状态"
            : "准备商城数据"
          : "确认商城数据状态"
        : "创建商城组织"
      : "确认商城初始化状态";

  return (
    <section
      className="surface mall-initialization"
      aria-labelledby="mall-initialization-title"
    >
      <header className="mall-initialization-heading">
        <div>
          <span>上线检查</span>
          <h2 id="mall-initialization-title">开始配置商城</h2>
          <p>按顺序完成必要配置，让访客可以浏览店铺并获得选购帮助。</p>
        </div>
        <div
          className="mall-initialization-next"
          aria-label={`下一步：${nextStep}`}
        >
          <span>下一步</span>
          <strong>{nextStep}</strong>
        </div>
      </header>
      <ol className="mall-initialization-list">
        <li className={rootReady ? "is-complete" : ""}>
          <div>
            <strong>商城组织</strong>
            <small>{setupDetail(setupResource, displaySetup)}</small>
          </div>
          {setupResource.status === "ready" ? (
            rootReady ? (
              <span>已完成</span>
            ) : setupResource.data.root.tenantExists &&
              rootRole === "rootSuperAdmin" ? (
              <button
                type="button"
                disabled={saving}
                onClick={onInitializeRoot}
              >
                {saving ? "创建中…" : "创建"}
              </button>
            ) : (
              <span>
                {setupResource.data.root.tenantExists
                  ? "需要商城负责人"
                  : "请先完成服务器初始化"}
              </span>
            )
          ) : (
            <span>状态待验证</span>
          )}
        </li>
        <li className={scopeReady ? "is-complete" : ""}>
          <div>
            <strong>商城数据</strong>
            <small>{domainDetail(domainsResource)}</small>
          </div>
          <button
            type="button"
            disabled={
              setupResource.status !== "ready" ||
              domainsResource.status !== "ready" ||
              !rootReady
            }
            onClick={() => onOpenStores(true)}
          >
            {domainsResource.status === "ready"
              ? scopeReady
                ? "管理"
                : "创建"
              : "待验证"}
          </button>
        </li>
        <li>
          <div>
            <strong>商城设置</strong>
            <small>品牌、用户协议、隐私政策和账号邮件。</small>
          </div>
          <button
            type="button"
            disabled={setupResource.status !== "ready" || !rootReady}
            onClick={onOpenSettings}
          >
            配置
          </button>
        </li>
        <li className={aiReady ? "is-complete" : ""}>
          <div>
            <strong>AI 导购</strong>
            <small>{aiDetail(aiResource, displayAi)}</small>
          </div>
          <button
            type="button"
            disabled={aiResource.status !== "ready"}
            onClick={onOpenAi}
          >
            {aiResource.status === "ready"
              ? aiReady
                ? "查看"
                : "配置"
              : "待验证"}
          </button>
        </li>
        <li className={firstStoreReady ? "is-complete" : ""}>
          <div>
            <strong>第一家店铺</strong>
            <small>
              {setupResource.status === "ready"
                ? firstStoreReady
                  ? "已有公开可浏览的店铺"
                  : "接入店铺并审核商品"
                : "商城数据状态尚未验证"}
            </small>
          </div>
          <button
            type="button"
            disabled={
              setupResource.status !== "ready" ||
              domainsResource.status !== "ready" ||
              !scopeReady
            }
            onClick={() => onOpenStores(false)}
          >
            {firstStoreReady ? "管理" : "接入"}
          </button>
        </li>
      </ol>
    </section>
  );
}

function setupDetail(
  state: PlatformSetupResourceState,
  setup: PlatformSetupStatus | undefined,
): string {
  if (state.status === "ready")
    return state.data.root.organization ? "已就绪" : "建立商城团队和管理边界";
  if (!setup)
    return state.status === "loading" ? "状态读取中" : "状态暂时不可用";
  return `上次状态：${setup.root.organization ? "已就绪" : "未完成"}；当前待验证`;
}

function domainDetail(state: PlatformDomainsResourceState): string {
  if (state.status === "ready")
    return state.data.length
      ? "店铺与商品数据已准备好"
      : "完成初始化后即可接入店铺";
  const domains = bootstrapResourceData(state);
  if (!domains)
    return state.status === "loading" ? "状态读取中" : "状态暂时不可用";
  return `上次状态：${domains.length ? "已就绪" : "未完成"}；当前待验证`;
}

function aiDetail(
  state: PlatformAiResourceState,
  ai: PlatformAiStatus | undefined,
): string {
  if (state.status === "ready")
    return state.data.router.configured
      ? "已连接模型服务"
      : "连接模型后，访客即可询问和选购";
  if (!ai) return state.status === "loading" ? "状态读取中" : "状态暂时不可用";
  return `上次状态：${ai.router.configured ? "已连接模型服务" : "模型未配置"}；当前待验证`;
}

import type { PlatformAiStatus, PlatformSetupStatus } from "../api";

interface MallInitializationPanelProps {
  setup: PlatformSetupStatus | null;
  rootRole?: string | null;
  aiStatus: PlatformAiStatus | null;
  saving: boolean;
  onInitializeRoot: () => void;
  onOpenStores: (openScope: boolean) => void;
  onOpenSettings: () => void;
  onOpenAi: () => void;
}

export function MallInitializationPanel({
  setup,
  rootRole,
  aiStatus,
  saving,
  onInitializeRoot,
  onOpenStores,
  onOpenSettings,
  onOpenAi,
}: MallInitializationPanelProps) {
  const rootReady = Boolean(setup?.root.organization);
  const scopeReady = Boolean(setup?.domains.length);
  const firstStoreReady = (setup?.routing.activeChildren ?? 0) > 0;
  const aiReady = aiStatus?.router.configured === true;
  const nextStep = rootReady
    ? scopeReady
      ? aiReady
        ? firstStoreReady
          ? "检查商城设置"
          : "接入第一家店铺"
        : "连接模型服务"
      : "准备商城数据"
    : "创建商城组织";

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
        <div className="mall-initialization-next" aria-label={`下一步：${nextStep}`}>
          <span>下一步</span>
          <strong>{nextStep}</strong>
        </div>
      </header>
      <ol className="mall-initialization-list">
        <li className={rootReady ? "is-complete" : ""}>
          <div>
            <strong>商城组织</strong>
            <small>{rootReady ? "已就绪" : "建立商城团队和管理边界"}</small>
          </div>
          {rootReady ? (
            <span>已完成</span>
          ) : setup?.root.tenantExists && rootRole === "rootSuperAdmin" ? (
            <button type="button" disabled={saving} onClick={onInitializeRoot}>
              {saving ? "创建中…" : "创建"}
            </button>
          ) : (
            <span>
              {setup?.root.tenantExists
                ? "需要商城负责人"
                : "请先完成服务器初始化"}
            </span>
          )}
        </li>
        <li className={scopeReady ? "is-complete" : ""}>
          <div>
            <strong>商城数据</strong>
            <small>
              {scopeReady ? "店铺与商品数据已准备好" : "完成初始化后即可接入店铺"}
            </small>
          </div>
          <button
            type="button"
            disabled={!rootReady}
            onClick={() => onOpenStores(true)}
          >
            {scopeReady ? "管理" : "创建"}
          </button>
        </li>
        <li>
          <div>
            <strong>商城设置</strong>
            <small>品牌、用户协议、隐私政策和账号邮件。</small>
          </div>
          <button type="button" disabled={!rootReady} onClick={onOpenSettings}>
            配置
          </button>
        </li>
        <li className={aiReady ? "is-complete" : ""}>
          <div>
            <strong>AI 导购</strong>
            <small>{aiReady ? "已连接模型服务" : "连接模型后，访客即可询问和选购"}</small>
          </div>
          <button type="button" onClick={onOpenAi}>
            {aiReady ? "查看" : "配置"}
          </button>
        </li>
        <li className={firstStoreReady ? "is-complete" : ""}>
          <div>
            <strong>第一家店铺</strong>
            <small>
              {firstStoreReady ? "已有公开可浏览的店铺" : "接入店铺并审核商品"}
            </small>
          </div>
          <button
            type="button"
            disabled={!scopeReady}
            onClick={() => onOpenStores(false)}
          >
            {firstStoreReady ? "管理" : "接入"}
          </button>
        </li>
      </ol>
    </section>
  );
}

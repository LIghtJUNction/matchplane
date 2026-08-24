import { ArrowLeft, Store } from "lucide-react";

export const metadata = {
  title: "404 · 页面不存在 - MatchPlane",
  description: "您访问的店铺或页面不存在，可能已被删除或地址有误。",
};

export default function NotFound() {
  return (
    <div className="not-found-page-wrapper">
      <header className="platform-header-minimal">
        <a href="/" className="platform-brand" aria-label="MatchPlane">
          <span className="brand-logo-mark">
            <Store size={20} aria-hidden="true" />
          </span>
          <span className="brand-name">MatchPlane</span>
        </a>
      </header>

      <main className="not-found-container" role="main">
        <div className="not-found-card surface">
          <div className="not-found-icon-wrapper" aria-hidden="true">
            <Store size={32} />
          </div>
          <div className="not-found-badge">404 NOT FOUND</div>
          <h1 className="not-found-title">店铺或页面不存在</h1>
          <p className="not-found-description">
            您访问的店铺或页面未找到，可能已被店主删除、下线或地址输入有误。
          </p>
          <div className="not-found-actions">
            <a href="/" className="button button-dark">
              <ArrowLeft size={16} aria-hidden="true" />
              返回商城首页
            </a>
          </div>
        </div>
      </main>
    </div>
  );
}

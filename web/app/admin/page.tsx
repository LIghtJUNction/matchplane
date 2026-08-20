"use client";

import { ShieldCheck, Settings, Sparkles, UsersRound } from "lucide-react";

export default function AdminPage() {
  return (
    <main className="admin-entry-page">
      <section className="admin-entry-card">
        <div className="admin-entry-icon">
          <ShieldCheck size={28} aria-hidden="true" />
        </div>
        <h1>MatchPlane 管理中心</h1>
        <p>
          管理用户、商家、认证 Provider、AI 模型和平台配置。
        </p>
        <div className="admin-entry-grid">
          <article>
            <UsersRound size={20} />
            <strong>用户与商家</strong>
            <span>账号、审核、权限管理</span>
          </article>
          <article>
            <Settings size={20} />
            <strong>平台设置</strong>
            <span>OAuth、安全、系统配置</span>
          </article>
          <article>
            <Sparkles size={20} />
            <strong>AI 模型</strong>
            <span>Provider 与模型策略</span>
          </article>
        </div>
      </section>
    </main>
  );
}

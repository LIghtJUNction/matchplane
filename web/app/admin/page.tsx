"use client";

import { Activity, BrainCircuit, KeyRound, ShieldCheck, Store, UsersRound } from "lucide-react";

const modules = [
  [UsersRound, "用户中心", "账号、角色、权限和登录状态"],
  [Store, "商家管理", "审核、服务发布和运营"],
  [KeyRound, "OAuth 中心", "微信、QQ、Google 等 Provider"],
  [BrainCircuit, "AI 模型", "模型、Endpoint 和策略"],
] as const;

export default function AdminPage() {
  return (
    <main className="admin-dashboard">
      <header className="admin-dashboard-header">
        <div>
          <div className="admin-dashboard-badge">
            <ShieldCheck size={16} /> Root Administration
          </div>
          <h1>MatchPlane 控制台</h1>
          <p>管理平台身份、AI 能力、商家生态和系统配置。</p>
        </div>
        <div className="admin-dashboard-status">
          <Activity size={18} /> 系统运行正常
        </div>
      </header>

      <section className="admin-dashboard-grid">
        {modules.map(([Icon, title, description]) => (
          <article className="admin-dashboard-card" key={title}>
            <div className="admin-dashboard-icon"><Icon size={24} /></div>
            <h2>{title}</h2>
            <p>{description}</p>
            <button type="button">进入管理</button>
          </article>
        ))}
      </section>
    </main>
  );
}

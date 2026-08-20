"use client";

import { BrainCircuit, KeyRound, ShieldCheck, Store, UsersRound } from "lucide-react";

const modules = [
  {
    icon: UsersRound,
    title: "用户中心",
    description: "账号、角色、权限和登录状态管理",
  },
  {
    icon: Store,
    title: "商家工作台",
    description: "商家审核、服务发布和运营管理",
  },
  {
    icon: KeyRound,
    title: "OAuth 配置",
    description: "微信、QQ、Google 等身份 Provider 管理",
  },
  {
    icon: BrainCircuit,
    title: "AI 模型中心",
    description: "模型 Provider、Endpoint 和策略配置",
  },
];

export default function AdminPage() {
  return (
    <main className="admin-entry-page">
      <section className="admin-entry-hero">
        <div className="admin-entry-badge">
          <ShieldCheck size={18} aria-hidden="true" />
          Root Administration
        </div>
        <h1>MatchPlane 管理中心</h1>
        <p>
          统一管理用户、商家、认证体系、AI 能力和平台运行配置。
        </p>

        <div className="admin-entry-grid">
          {modules.map(({ icon: Icon, title, description }) => (
            <article key={title} className="admin-entry-module">
              <span className="admin-entry-module-icon">
                <Icon size={22} aria-hidden="true" />
              </span>
              <strong>{title}</strong>
              <span>{description}</span>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

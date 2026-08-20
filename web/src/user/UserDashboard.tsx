"use client";

import { BrainCircuit, ClipboardList, Search } from "lucide-react";

const sections = [
  {
    icon: Search,
    title: "需求匹配",
    description: "输入你的需求，让平台帮助寻找合适的服务。",
  },
  {
    icon: BrainCircuit,
    title: "AI 分析",
    description: "查看 AI 对需求和候选方案的分析结果。",
  },
  {
    icon: ClipboardList,
    title: "订单与记录",
    description: "管理历史请求、匹配结果和沟通状态。",
  },
];

export default function UserDashboard() {
  return (
    <section className="user-dashboard">
      <header>
        <h1>用户中心</h1>
        <p>管理需求、匹配结果和服务流程。</p>
      </header>

      <div className="user-dashboard-grid">
        {sections.map(({ icon: Icon, title, description }) => (
          <article key={title}>
            <Icon size={24} aria-hidden="true" />
            <h2>{title}</h2>
            <p>{description}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

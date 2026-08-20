"use client";

import { ShieldCheck } from "lucide-react";

export default function SecurityPage() {
  return (
    <section className="admin-panel">
      <div className="admin-panel-title">
        <ShieldCheck size={22} />
        <h1>Security Center</h1>
      </div>
      <p>管理登录策略、权限控制、密钥保护和安全策略。</p>
    </section>
  );
}

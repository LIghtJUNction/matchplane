import { ReactNode } from "react";

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="auth-layout">
      <section className="auth-card">
        <header className="auth-header">
          <h1>Welcome to MatchPlane</h1>
          <p>统一管理需求匹配、商家服务和 AI 能力。</p>
        </header>
        {children}
      </section>
    </main>
  );
}

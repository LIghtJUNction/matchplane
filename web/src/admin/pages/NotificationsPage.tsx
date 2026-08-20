"use client";

export default function NotificationsPage() {
  const items = [
    "系统异常通知",
    "管理员操作通知",
    "OAuth Provider 状态变化",
    "AI 服务健康状态",
  ];

  return (
    <section className="admin-page">
      <header>
        <h1>Notifications</h1>
        <p>统一管理平台消息和运行通知。</p>
      </header>
      <div className="admin-card-grid">
        {items.map((item) => (
          <article key={item} className="admin-card">
            <strong>{item}</strong>
            <span>已启用</span>
          </article>
        ))}
      </div>
    </section>
  );
}

"use client";

const logs = [
  ["admin.login", "管理员登录", "刚刚"],
  ["oauth.update", "OAuth 配置更新", "10 分钟前"],
  ["model.change", "AI 模型配置修改", "30 分钟前"],
];

export default function AuditLogsPage() {
  return (
    <section>
      <h1>Audit Logs</h1>
      <p>查看平台关键操作记录。</p>
      <div>
        {logs.map(([event, description, time]) => (
          <article key={event}>
            <strong>{description}</strong>
            <span>{event} · {time}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

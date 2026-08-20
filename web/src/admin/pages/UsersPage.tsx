"use client";

const users = [
  ["user_001", "Normal User", "Active"],
  ["user_002", "Merchant User", "Pending"],
];

export default function UsersPage() {
  return (
    <section className="admin-page-section">
      <header>
        <h1>用户管理</h1>
        <p>管理账号、角色、登录状态和权限。</p>
      </header>
      <div className="admin-table-card">
        {users.map(([id, role, status]) => (
          <div key={id} className="admin-table-row">
            <strong>{id}</strong>
            <span>{role}</span>
            <span>{status}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

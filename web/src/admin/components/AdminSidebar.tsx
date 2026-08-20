"use client";

const items = [
  "Dashboard",
  "Users",
  "Merchants",
  "OAuth Providers",
  "AI Models",
  "Security",
  "Audit Logs",
];

export function AdminSidebar() {
  return (
    <aside className="admin-sidebar">
      <div className="admin-sidebar-title">MatchPlane</div>
      <nav>
        {items.map((item) => (
          <a key={item} href="#">
            {item}
          </a>
        ))}
      </nav>
    </aside>
  );
}

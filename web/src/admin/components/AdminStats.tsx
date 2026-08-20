"use client";

const stats = [
  ["Users", "12,480"],
  ["Merchants", "356"],
  ["AI Providers", "8"],
  ["OAuth Providers", "6"],
];

export function AdminStats() {
  return (
    <section className="admin-stats">
      {stats.map(([label, value]) => (
        <article key={label}>
          <small>{label}</small>
          <strong>{value}</strong>
        </article>
      ))}
    </section>
  );
}

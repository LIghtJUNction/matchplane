"use client";

const merchants = [
  ["merchant_001", "Example Store", "Review"],
  ["merchant_002", "AI Service Provider", "Approved"],
];

export default function MerchantsPage() {
  return (
    <section className="admin-page-section">
      <header>
        <h1>商家管理</h1>
        <p>审核商家资料、管理服务发布和运营状态。</p>
      </header>
      <div className="admin-table-card">
        {merchants.map(([id, name, status]) => (
          <div key={id} className="admin-table-row">
            <strong>{name}</strong>
            <span>{id}</span>
            <span>{status}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

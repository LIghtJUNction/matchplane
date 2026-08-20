const sections = [
  "Profile verification",
  "Service management",
  "Customer requests",
  "Analytics",
];

export function MerchantDashboard() {
  return (
    <section className="merchant-dashboard">
      <h1>Merchant Workspace</h1>
      <p>管理商家资料、服务和匹配请求。</p>
      <div>
        {sections.map((section) => (
          <article key={section}>{section}</article>
        ))}
      </div>
    </section>
  );
}

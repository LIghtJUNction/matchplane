"use client";

const providers = [
  "WeChat",
  "QQ",
  "Alipay",
  "Google",
  "GitHub",
  "Microsoft",
];

export default function OAuthProvidersPage() {
  return (
    <section className="admin-panel">
      <header>
        <h1>OAuth Providers</h1>
        <p>管理第三方登录渠道和 OAuth 配置。</p>
      </header>
      <div className="admin-provider-grid">
        {providers.map((provider) => (
          <article key={provider}>
            <strong>{provider}</strong>
            <span>Client ID / Secret / Redirect URL</span>
            <button type="button">配置</button>
          </article>
        ))}
      </div>
    </section>
  );
}

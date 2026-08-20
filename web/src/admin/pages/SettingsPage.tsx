"use client";

const settings = [
  "General Configuration",
  "Authentication Providers",
  "AI Providers",
  "Security Policy",
];

export default function SettingsPage() {
  return (
    <section>
      <h1>Settings</h1>
      <p>集中管理 MatchPlane 平台配置。</p>
      <div>
        {settings.map((item) => (
          <article key={item}>{item}</article>
        ))}
      </div>
    </section>
  );
}

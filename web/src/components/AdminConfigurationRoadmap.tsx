"use client";

const items = [
  "Authentication providers: phone, email, OAuth",
  "OAuth credentials and callback management",
  "AI providers and model policies",
  "Security and audit configuration",
];

export function AdminConfigurationRoadmap() {
  return (
    <section aria-label="Administration configuration roadmap">
      <h2>平台配置</h2>
      <ul>
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </section>
  );
}

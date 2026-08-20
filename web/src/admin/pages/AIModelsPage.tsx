"use client";

const models = ["OpenAI", "Anthropic", "Gemini", "Custom Endpoint"];

export default function AIModelsPage() {
  return (
    <section className="admin-panel">
      <header>
        <h1>AI Models</h1>
        <p>配置模型 Provider、Endpoint 和运行策略。</p>
      </header>
      <div className="admin-provider-grid">
        {models.map((model) => (
          <article key={model}>
            <strong>{model}</strong>
            <span>API Key / Endpoint / Default Model</span>
            <button type="button">配置</button>
          </article>
        ))}
      </div>
    </section>
  );
}

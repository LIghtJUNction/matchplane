"use client";

import { useState } from "react";

export default function RequestBuilder() {
  const [request, setRequest] = useState("");

  return (
    <section className="request-builder">
      <header>
        <h2>描述你的需求</h2>
        <p>MatchPlane 将根据需求匹配合适的服务提供方。</p>
      </header>

      <textarea
        value={request}
        onChange={(event) => setRequest(event.target.value)}
        placeholder="例如：寻找一个支持 AI 自动化的服务..."
        rows={6}
      />

      <button type="button" disabled={!request.trim()}>
        开始智能匹配
      </button>
    </section>
  );
}

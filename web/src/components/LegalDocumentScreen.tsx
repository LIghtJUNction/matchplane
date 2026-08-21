"use client";

import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";

import { getMallLegalDocuments, type MallLegalDocuments } from "../api";

export function LegalDocumentScreen({ kind }: { kind: "terms" | "privacy" }) {
  const [legal, setLegal] = useState<MallLegalDocuments | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void getMallLegalDocuments()
      .then((value) => { if (mounted) setLegal(value); })
      .catch((cause) => { if (mounted) setError(cause instanceof Error ? cause.message : "页面暂时不可用"); });
    return () => { mounted = false; };
  }, []);

  const document = legal?.documents[kind];
  const title = kind === "terms" ? "用户协议" : "隐私政策";
  const content = document ? document.content.replaceAll("{{mall_name}}", legal.mallName) : "";
  return (
    <main className="legal-page">
      <header className="legal-page-header">
        <a href="/" className="legal-page-back"><ArrowLeft size={17} aria-hidden="true" />返回商城</a>
        <span>{legal?.mallName || "商城"}</span>
      </header>
      <article className="legal-document" aria-labelledby="legal-document-title">
        {document ? <><h1 id="legal-document-title">{title}</h1><p className="legal-document-meta">更新于 {formatDate(document.updatedAt)}</p><div>{content}</div></> : <><h1 id="legal-document-title">{title}</h1><p className={error ? "legal-document-error" : "legal-document-meta"}>{error || "正在加载…"}</p></>}
      </article>
    </main>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("zh-CN");
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { Button } from "@appica/ui-react/button";

import { getMallLegalDocuments, type MallLegalDocuments } from "../api";

type LegalDocumentLoadState = "loading" | "ready" | "error";

export function LegalDocumentScreen({ kind }: { kind: "terms" | "privacy" }) {
  const [legal, setLegal] = useState<MallLegalDocuments | null>(null);
  const [loadState, setLoadState] = useState<LegalDocumentLoadState>("loading");
  const requestIdRef = useRef(0);

  const loadDocument = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoadState("loading");

    try {
      const value = await getMallLegalDocuments();
      if (requestId !== requestIdRef.current) return;
      setLegal(value);
      setLoadState("ready");
    } catch {
      if (requestId !== requestIdRef.current) return;
      setLegal(null);
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    void loadDocument();
    return () => {
      requestIdRef.current += 1;
    };
  }, [loadDocument]);

  const document = legal?.documents[kind];
  const title = kind === "terms" ? "用户协议" : "隐私政策";
  const content = document
    ? document.content.replaceAll("{{mall_name}}", legal.mallName)
    : "";

  return (
    <main className="legal-page">
      <header className="legal-page-header">
        <a href="/" className="legal-page-back">
          <ArrowLeft size={17} aria-hidden="true" />
          返回商城
        </a>
        <span>{legal?.mallName || "商城"}</span>
      </header>
      <article
        className="legal-document"
        aria-labelledby="legal-document-title"
      >
        <h1 id="legal-document-title">{title}</h1>
        {loadState === "loading" ? (
          <p className="legal-document-meta" role="status">
            正在加载当前版本…
          </p>
        ) : null}
        {loadState === "error" ? (
          <div className="legal-document-load-error">
            <p role="alert">协议内容暂时无法读取，请稍后重试。</p>
            <Button
              className="legal-document-retry"
              variant="outline"
              type="button"
              onClick={() => void loadDocument()}
            >
              <RefreshCw size={15} aria-hidden="true" />
              重新加载
            </Button>
          </div>
        ) : null}
        {loadState === "ready" && document ? (
          <>
            <p className="legal-document-meta">
              更新于 {formatDate(document.updatedAt)}
            </p>
            <div className="legal-document-content">{content}</div>
          </>
        ) : null}
      </article>
    </main>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("zh-CN");
}

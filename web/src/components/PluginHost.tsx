"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ExternalLink, ShieldCheck } from "lucide-react";

import type { SubplatformConfig } from "../subplatform";
import type { WorkspaceRole } from "../types";

interface PluginHostProps {
  subplatform: SubplatformConfig;
  role: WorkspaceRole;
  onNotice: (message: string) => void;
  fallback: ReactNode;
}

/**
 * Host a verified static subplatform UI in a capability-limited iframe. The
 * plugin receives context through postMessage and can request the shared chat,
 * but it never receives a session token or payment/contact authority.
 */
export function PluginHost({ subplatform, role, onNotice, fallback }: PluginHostProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [failed, setFailed] = useState(false);
  const artifact = subplatform.pluginArtifact;

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== frameRef.current?.contentWindow || !isRecord(event.data)) return;
      if (event.data.protocol !== "matchplane.plugin/v1") return;
      if (event.data.type === "chat.open") {
        document.getElementById("match-chat-input")?.focus();
        onNotice("已打开共享 AI 撮合输入框");
      } else if (event.data.type === "listing.select") {
        onNotice("插件已提交供给选择，平台会继续按权限撮合");
      } else if (event.data.type === "listing.submit") {
        onNotice("插件资料已收到；正式发布仍需通过根平台供给审核接口");
      } else if (event.data.type === "navigation") {
        onNotice("插件导航请求已收到；平台会校验当前路径权限");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onNotice]);

  if (!artifact) return null;

  return (
    <div className="plugin-workspace">
      <section className="plugin-host" aria-label={`${subplatform.brandName} 插件界面`}>
        <div className="plugin-host-bar">
          <span><ShieldCheck size={15} aria-hidden="true" />已验证静态插件</span>
          <small>{artifact.digest.slice(0, 12)}…</small>
          <a href={artifact.url} target="_blank" rel="noreferrer">
            <ExternalLink size={14} aria-hidden="true" />独立打开
          </a>
        </div>
        {failed ? (
          <div className="plugin-host-fallback">
            <p role="status">插件界面暂时不可用，已回退到平台通用工作台。</p>
            {fallback}
          </div>
        ) : (
          <iframe
            ref={frameRef}
            className="plugin-frame"
            title={`${subplatform.brandName} ${role} 工作台`}
            src={artifact.url}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            loading="lazy"
            onError={() => setFailed(true)}
            onLoad={() => {
              frameRef.current?.contentWindow?.postMessage({
                protocol: "matchplane.plugin/v1",
                type: "platform.context",
                version: 1,
                payload: {
                  path: subplatform.path,
                  platform: subplatform.slug,
                  role,
                capabilities: ["chat.open", "listing.select", "listing.submit", "navigation"],
                },
              }, "*");
            }}
          />
        )}
      </section>
    </div>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

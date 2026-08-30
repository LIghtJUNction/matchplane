"use client";

import type { InterfaceLocale } from "../lib/preferences";
import { AssistantLiquidIndicator } from "./AssistantLiquidIndicator";
import styles from "./AssistantThinkingStatus.module.css";

interface AssistantThinkingStatusProps {
  locale: InterfaceLocale;
  mode: "shopping" | "store" | "seller";
}

export function AssistantThinkingStatus({
  locale,
  mode,
}: AssistantThinkingStatusProps) {
  const english = locale === "en";
  const copy = {
    shopping: {
      title: english ? "Searching public stores" : "正在检索公开店铺",
      detail: english ? "Checking fit and source" : "核对需求、商品与来源",
    },
    store: {
      title: english ? "Preparing a reply" : "正在准备回复",
      detail: english
        ? "Using this store's live context"
        : "结合当前店铺信息作答",
    },
    seller: {
      title: english ? "Organizing the listing" : "正在整理商品信息",
      detail: english
        ? "Structuring details for review"
        : "生成可检查的结构化内容",
    },
  }[mode];

  return (
    <div
      className={`${styles.status} assistant-thinking-status`}
      role="status"
      aria-label={english ? "Replying…" : "正在回复…"}
    >
      <AssistantLiquidIndicator activity={mode} />
      <span className={styles.copy}>
        <strong>{copy.title}</strong>
        <span>{copy.detail}</span>
      </span>
    </div>
  );
}

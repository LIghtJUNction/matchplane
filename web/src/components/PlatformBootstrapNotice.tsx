"use client";

import { Button } from "@appica/ui-react/button";
import { AlertTriangle, RefreshCw } from "lucide-react";

import type {
  PlatformAiResourceState,
  PlatformBootstrapResourceKey,
  PlatformDomainsResourceState,
  PlatformSetupResourceState,
} from "../hooks/usePlatformBootstrapResources";

interface PlatformBootstrapNoticeProps {
  authorized: boolean;
  setup: PlatformSetupResourceState;
  domains: PlatformDomainsResourceState;
  ai: PlatformAiResourceState;
  onRetryFailed: () => void;
}

const resourceKeys = [
  "setup",
  "domains",
  "ai",
] as const satisfies readonly PlatformBootstrapResourceKey[];

const labels: Record<PlatformBootstrapResourceKey, string> = {
  setup: "商城初始化状态",
  domains: "商城数据范围",
  ai: "AI 状态",
};

export function PlatformBootstrapNotice({
  authorized,
  setup,
  domains,
  ai,
  onRetryFailed,
}: PlatformBootstrapNoticeProps) {
  if (!authorized) {
    return (
      <div className="bootstrap-resource-status" role="status">
        需要商城负责人或管理员权限才能读取商城启动状态。
      </div>
    );
  }

  const states = { setup, domains, ai };
  const failedKeys = resourceKeys.filter(
    (key) => states[key].status === "error",
  );
  const loadingKeys = resourceKeys.filter(
    (key) => states[key].status === "loading",
  );

  return (
    <>
      {loadingKeys.length ? (
        <div className="bootstrap-resource-status" role="status">
          正在读取{loadingKeys.map((key) => labels[key]).join("、")}
          ；已完成的状态保持可用。
        </div>
      ) : null}
      {failedKeys.length ? (
        <div className="bootstrap-resource-alert" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>部分商城启动状态暂时无法验证</strong>
            <ul>
              {failedKeys.map((key) => {
                const state = states[key];
                return (
                  <li key={key}>
                    {labels[key]}：
                    {state.status === "error" ? state.message : "读取失败"}
                    {state.status === "error" && state.previous !== undefined
                      ? "；保留的旧状态仅供参考"
                      : ""}
                  </li>
                );
              })}
            </ul>
          </div>
          <Button
            className="min-h-11 sm:min-h-9"
            size="sm"
            type="button"
            variant="outline"
            onClick={onRetryFailed}
          >
            <RefreshCw size={15} aria-hidden="true" />
            重新读取失败项
          </Button>
        </div>
      ) : null}
    </>
  );
}

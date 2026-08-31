import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  activateManagedPlatformRouterConfig: vi.fn(),
  getManagedPlatformRouterState: vi.fn(),
  saveManagedPlatformRouterConfig: vi.fn(),
  testPlatformAi: vi.fn(),
}));

vi.mock("../api", () => api);

import { PlatformAiConfigPanel } from "./PlatformAiConfigPanel";

const longEndpoint =
  "https://gateway.example.test/organizations/matchplane/environments/production-compatible-endpoint/v1";

const config = {
  endpoint: longEndpoint,
  model: "test-model",
  protocol: "openai-compatible" as const,
  enabled: true,
  credentialConfigured: true,
  credentialFile: "platform-router-ai.key",
  assistantInstructions: "",
  assistantMaxOutputTokens: 320,
  assistantTemperature: 0.2,
  assistantMaxSteps: 3,
  assistantTimeoutMs: 20_000,
  assistantReasoningEffort: "none",
  modelReasoningEfforts: [] as string[],
  updatedAt: "2026-08-24T00:00:00.000Z",
};

const effective = {
  ready: false,
  code: "managed_configuration_invalid" as const,
  source: "managed" as const,
  managedOverridesEnvironment: true,
  conflicts: { endpoint: true, model: false, protocol: false },
  endpointOrigin: "https://gateway.example.test",
  model: "test-model",
  protocol: "openai-compatible" as const,
  enabled: true,
  credentialConfigured: true,
  originAllowlistApplied: false,
  issues: ["endpoint_origin_not_allowed"],
};

function draft(overrides: Record<string, unknown> = {}) {
  return {
    ...config,
    testedReady: false,
    testedAt: null,
    keyChanged: false,
    ...overrides,
  };
}

function readyProbe(readyDraft = draft({ testedReady: true })) {
  return {
    status: "ready",
    outcome: "ready",
    phase: "response",
    model: readyDraft.model,
    responseStatus: 200,
    latencyMs: 650,
    firstByteLatencyMs: 500,
    performanceBudgetMs: 4_000,
    hardTimeoutMs: 20_000,
    message: "模型网关连接正常。",
    requestId: "request-test-ready",
    committed: true,
    auditPending: false,
    maintenancePending: false,
    generationId: "generation-test-ready",
    config,
    draft: readyDraft,
    effective,
  };
}

function renderPanel(
  options: { role?: string; onNotice?: (message: string) => void } = {},
) {
  return render(
    <PlatformAiConfigPanel
      rootRole={options.role ?? "rootSuperAdmin"}
      onNotice={options.onNotice ?? vi.fn()}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getManagedPlatformRouterState.mockResolvedValue({
    config,
    draft: null,
    effective,
  });
  api.saveManagedPlatformRouterConfig.mockImplementation(async (input) => ({
    config,
    draft: draft({
      ...input,
      credentialConfigured: true,
      updatedAt: "2026-08-24T00:05:00.000Z",
    }),
    effective,
  }));
  api.testPlatformAi.mockResolvedValue(readyProbe());
  api.activateManagedPlatformRouterConfig.mockResolvedValue({
    config: { ...config, updatedAt: "2026-08-24T00:10:00.000Z" },
    draft: null,
    effective: {
      ...effective,
      ready: true,
      code: "ready",
      issues: [],
      originAllowlistApplied: true,
    },
  });
});

describe("PlatformAiConfigPanel provider-first configuration", () => {
  it("keeps operators read-only and explains who can configure", async () => {
    renderPanel({ role: "rootAdmin" });

    expect(await screen.findByLabelText("AI 服务商")).toBeDisabled();
    expect(screen.getByLabelText("模型 ID")).toBeDisabled();
    expect(screen.getByLabelText("API Key")).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存并测试" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "应用到生产" })).toBeDisabled();
    expect(screen.getByText(/只有商城负责人可以修改并应用/)).toBeVisible();
    expect(api.saveManagedPlatformRouterConfig).not.toHaveBeenCalled();
  });

  it("turns official providers into one choice instead of protocol and endpoint work", async () => {
    const user = userEvent.setup();
    renderPanel();

    const provider = await screen.findByLabelText("AI 服务商");
    expect(provider).toHaveValue("custom");
    expect(screen.getByLabelText("API 基址")).toHaveValue(longEndpoint);
    await user.type(screen.getByLabelText("API Key"), "transient-custom-key");

    await user.selectOptions(provider, "anthropic");
    expect(screen.getByLabelText("API Key")).toHaveValue("");
    expect(screen.queryByLabelText("兼容协议")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("API 基址")).not.toBeInTheDocument();
    expect(
      screen.getByText(/https:\/\/api\.anthropic\.com/),
    ).toBeVisible();
    expect(screen.getByLabelText("模型 ID")).toHaveValue("");
    expect(screen.getByLabelText("模型 ID")).toHaveAttribute(
      "placeholder",
      "例如 claude-…",
    );

    await user.selectOptions(provider, "gemini");
    expect(
      screen.getByText(/generativelanguage\.googleapis\.com/),
    ).toBeVisible();
  });

  it("keeps custom compatible gateways first-class and manual", async () => {
    renderPanel();

    await screen.findByDisplayValue(longEndpoint);
    expect(screen.getByLabelText("兼容协议")).toHaveValue(
      "openai-compatible",
    );
    expect(screen.getByLabelText("API 基址")).toBeRequired();
    expect(screen.getByLabelText("模型 ID")).toBeRequired();
    expect(
      screen.queryByRole("button", { name: /获取模型列表/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/中转网关、私有部署和兼容接口/)).toBeVisible();
  });

  it("saves then tests in order without activating and keeps the key write-only", async () => {
    const user = userEvent.setup();
    const testedDraft = draft({
      model: "manual-provider-model",
      testedReady: true,
      testedAt: "2026-08-24T00:06:00.000Z",
      keyChanged: true,
    });
    api.testPlatformAi.mockResolvedValue(readyProbe(testedDraft));
    renderPanel();

    const model = await screen.findByLabelText("模型 ID");
    const key = screen.getByLabelText("API Key");
    expect(key).toHaveValue("");
    await user.clear(model);
    await user.type(model, "manual-provider-model");
    await user.type(key, "write-only-new-key");
    await user.click(screen.getByRole("button", { name: "保存并测试" }));

    await waitFor(() =>
      expect(api.testPlatformAi).toHaveBeenCalledWith({ candidate: true }),
    );
    expect(api.saveManagedPlatformRouterConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: longEndpoint,
        model: "manual-provider-model",
        apiKey: "write-only-new-key",
        enabled: true,
      }),
    );
    expect(
      api.saveManagedPlatformRouterConfig.mock.invocationCallOrder[0],
    ).toBeLessThan(api.testPlatformAi.mock.invocationCallOrder[0]);
    expect(api.activateManagedPlatformRouterConfig).not.toHaveBeenCalled();
    expect(key).toHaveValue("");
    expect(screen.getByRole("button", { name: "应用到生产" })).toBeEnabled();
  });

  it("invalidates a tested draft as soon as any local field or key changes", async () => {
    const user = userEvent.setup();
    api.getManagedPlatformRouterState.mockResolvedValue({
      config,
      draft: draft({
        testedReady: true,
        testedAt: "2026-08-24T00:00:00.000Z",
      }),
      effective,
    });
    renderPanel();

    const activate = await screen.findByRole("button", {
      name: "应用到生产",
    });
    await waitFor(() => expect(activate).toBeEnabled());

    await user.type(screen.getByLabelText("模型 ID"), "-changed");
    expect(activate).toBeDisabled();
    expect(screen.getByText(/尚未测试的改动/)).toBeVisible();

    await user.clear(screen.getByLabelText("模型 ID"));
    await user.type(screen.getByLabelText("模型 ID"), config.model);
    await waitFor(() => expect(activate).toBeEnabled());

    await user.type(screen.getByLabelText("API Key"), "replacement-key");
    expect(activate).toBeDisabled();
  });

  it("requires a new credential after switching to a different connection", async () => {
    const user = userEvent.setup();
    renderPanel();

    const provider = await screen.findByLabelText("AI 服务商");
    await user.selectOptions(provider, "anthropic");
    const saveAndTest = screen.getByRole("button", { name: "保存并测试" });
    expect(saveAndTest).toBeDisabled();

    await user.type(screen.getByLabelText("模型 ID"), "claude-provider-model");
    expect(saveAndTest).toBeDisabled();
    await user.type(screen.getByLabelText("API Key"), "anthropic-new-key");
    expect(saveAndTest).toBeEnabled();
  });

  it("unlocks every control after a failed probe and keeps a recoverable draft", async () => {
    const user = userEvent.setup();
    api.testPlatformAi.mockRejectedValue(new Error("模拟测试失败"));
    renderPanel();

    await screen.findByDisplayValue(longEndpoint);
    await user.type(screen.getByLabelText("模型 ID"), "-next");
    await user.click(screen.getByRole("button", { name: "保存并测试" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("模拟测试失败");
    expect(screen.getByRole("button", { name: "重新测试" })).toBeEnabled();
    expect(screen.getByLabelText("AI 服务商")).toBeEnabled();
    expect(api.activateManagedPlatformRouterConfig).not.toHaveBeenCalled();
  });

  it("prevents concurrent configuration mutations", async () => {
    const user = userEvent.setup();
    let resolveSave: ((value: unknown) => void) | undefined;
    api.saveManagedPlatformRouterConfig.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    renderPanel();

    await screen.findByDisplayValue(longEndpoint);
    await user.type(screen.getByLabelText("模型 ID"), "-next");
    await user.click(screen.getByRole("button", { name: "保存并测试" }));

    expect(screen.getByRole("button", { name: "保存并测试中…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "应用到生产" })).toBeDisabled();
    expect(screen.getByLabelText("AI 服务商")).toBeDisabled();

    resolveSave?.({ config, draft: draft(), effective });
    await waitFor(() => expect(api.testPlatformAi).toHaveBeenCalledTimes(1));
  });

  it("applies only a clean attested draft", async () => {
    const user = userEvent.setup();
    const testedDraft = draft({
      testedReady: true,
      testedAt: "2026-08-24T00:00:00.000Z",
    });
    api.getManagedPlatformRouterState.mockResolvedValue({
      config,
      draft: testedDraft,
      effective,
    });
    api.activateManagedPlatformRouterConfig.mockResolvedValue({
      config: testedDraft,
      draft: null,
      effective: { ...effective, ready: true, code: "ready", issues: [] },
    });
    renderPanel();

    const activate = await screen.findByRole("button", {
      name: "应用到生产",
    });
    await waitFor(() => expect(activate).toBeEnabled());
    await user.click(activate);

    await waitFor(() =>
      expect(api.activateManagedPlatformRouterConfig).toHaveBeenCalledTimes(1),
    );
    expect(await screen.findByText(/配置已应用/)).toBeVisible();
  });

  it("reports committed 202-style maintenance without fabricating failure", async () => {
    const user = userEvent.setup();
    const onNotice = vi.fn();
    api.testPlatformAi.mockResolvedValue({
      ...readyProbe(draft({ testedReady: true })),
      maintenancePending: true,
    });
    renderPanel({ onNotice });

    await screen.findByDisplayValue(longEndpoint);
    await user.type(screen.getByLabelText("模型 ID"), "-next");
    await user.click(screen.getByRole("button", { name: "保存并测试" }));

    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith("已提交，后台清理待完成"),
    );
    expect(screen.getByRole("button", { name: "应用到生产" })).toBeEnabled();
  });

  it("shows an inline load failure and retries without remounting", async () => {
    const user = userEvent.setup();
    api.getManagedPlatformRouterState
      .mockRejectedValueOnce(new Error("读取暂时失败"))
      .mockResolvedValueOnce({ config, draft: null, effective });
    renderPanel();

    expect(await screen.findByRole("alert")).toHaveTextContent("读取暂时失败");
    await user.click(screen.getByRole("button", { name: "重新读取" }));

    expect(await screen.findByLabelText("AI 服务商")).toBeVisible();
    expect(api.getManagedPlatformRouterState).toHaveBeenCalledTimes(2);
  });

  it("keeps advanced controls collapsed but keyboard-reachable", async () => {
    const user = userEvent.setup();
    renderPanel();

    await screen.findByLabelText("AI 服务商");
    const advanced = screen.getByText("导购行为与高级设置");
    expect(screen.queryByLabelText("补充指引（可选）")).not.toBeVisible();
    await user.click(advanced);
    expect(screen.getByLabelText("补充指引（可选）")).toBeVisible();
    expect(screen.getByText(/公开店铺与商品检索/)).toBeVisible();
  });

  it("defaults an empty managed state to the official OpenAI path", async () => {
    api.getManagedPlatformRouterState.mockResolvedValue({
      config: null,
      draft: null,
      effective: {
        ...effective,
        ready: false,
        source: "none",
        managedOverridesEnvironment: false,
        conflicts: { endpoint: null, model: null, protocol: null },
        endpointOrigin: null,
        model: null,
        protocol: null,
        enabled: false,
        credentialConfigured: false,
        issues: ["provider_not_configured"],
      },
    });
    renderPanel();

    expect(await screen.findByLabelText("AI 服务商")).toHaveValue("openai");
    expect(screen.queryByLabelText("API 基址")).not.toBeInTheDocument();
    expect(screen.getByText(/api\.openai\.com\/v1/)).toBeVisible();
    expect(screen.getByRole("button", { name: "保存并测试" })).toBeDisabled();
  });

  it("does not claim a managed conflict when conflict fields are unreadable", async () => {
    api.getManagedPlatformRouterState.mockResolvedValue({
      config: null,
      draft: null,
      effective: {
        ...effective,
        ready: false,
        source: "managed",
        conflicts: { endpoint: null, model: null, protocol: null },
        endpointOrigin: null,
        model: null,
        protocol: null,
        originAllowlistApplied: false,
        issues: ["managed_configuration_unreadable"],
      },
    });
    renderPanel();

    expect(
      (await screen.findAllByText("托管配置无法安全读取")).length,
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("查看连接详情"));
    expect(screen.queryByText(/非秘密配置存在冲突/)).not.toBeInTheDocument();
  });
});

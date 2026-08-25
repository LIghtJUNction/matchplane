import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  activateManagedPlatformRouterConfig: vi.fn(),
  getManagedPlatformRouterState: vi.fn(),
  saveManagedPlatformRouterConfig: vi.fn(),
  testPlatformAi: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  ...api,
}));

import { PlatformAiConfigPanel } from "./PlatformAiConfigPanel";

const longEndpoint =
  "https://gateway.example.test/organizations/matchplane/environments/production-compatible-endpoint/v1";
const config = {
  endpoint: longEndpoint,
  model: "test-model",
  protocol: "openai-compatible" as const,
  enabled: true,
  credentialConfigured: true,
  assistantInstructions: "",
  assistantMaxOutputTokens: 320,
  assistantTemperature: 0.2,
  assistantMaxSteps: 3,
  assistantTimeoutMs: 20_000,
  assistantReasoningEffort: "none",
  modelReasoningEfforts: [],
};
const effective = {
  ready: false,
  code: "upstream_configuration" as const,
  preferredHttpStatus: 451 as const,
  source: "managed" as const,
  managedOverridesEnvironment: true,
  conflicts: { endpoint: true, model: true, protocol: false },
  endpointOrigin: "https://gateway.example.test",
  model: "test-model",
  protocol: "openai-compatible" as const,
  enabled: true,
  credentialConfigured: true,
  originAllowlistApplied: false,
  issues: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.getManagedPlatformRouterState.mockResolvedValue({
    config,
    draft: { ...config, testedReady: false, testedAt: null, keyChanged: true },
    effective,
  });
});

describe("PlatformAiConfigPanel staged cutover", () => {
  it("keeps read-only controls accessible and performs no mutations", async () => {
    const user = userEvent.setup();
    render(<PlatformAiConfigPanel rootRole="rootViewer" onNotice={vi.fn()} />);
    const save = await screen.findByRole("button", { name: "保存待测配置" });
    const activate = screen.getByRole("button", { name: "启用已测试配置" });
    expect(save).toBeDisabled();
    expect(activate).toBeDisabled();
    await user.click(save);
    await user.click(activate);
    expect(api.saveManagedPlatformRouterConfig).not.toHaveBeenCalled();
    expect(api.activateManagedPlatformRouterConfig).not.toHaveBeenCalled();
    expect(api.testPlatformAi).not.toHaveBeenCalled();
  });

  it("reports a rejected slow candidate honestly without applying uncommitted state", async () => {
    const user = userEvent.setup();
    const onNotice = vi.fn();
    api.testPlatformAi.mockRejectedValue(
      new Error("模型网关可达，但响应较慢。"),
    );

    const { container } = render(
      <PlatformAiConfigPanel rootRole="rootSuperAdmin" onNotice={onNotice} />,
    );

    const endpoint = await screen.findByDisplayValue(longEndpoint);
    expect(endpoint.closest(".platform-ai-endpoint-field")).not.toBeNull();
    expect(container.querySelector(".platform-ai-config")).toContainElement(
      endpoint,
    );
    expect(screen.getByText(/WebUI managed 配置正在覆盖 env/)).toBeVisible();

    const testButton = screen.getByRole("button", {
      name: "测试待测配置",
    });
    await waitFor(() => expect(testButton).toBeEnabled());
    await user.click(testButton);

    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith("模型网关可达，但响应较慢。"),
    );
    expect(api.testPlatformAi).toHaveBeenCalledWith({ candidate: true });
    expect(
      screen.getByRole("button", { name: "启用已测试配置" }),
    ).toBeDisabled();
  });

  it("prevents concurrent mutations and unlocks every control after a failed test", async () => {
    const user = userEvent.setup();
    const onNotice = vi.fn();
    let failProbe = () => {};
    api.getManagedPlatformRouterState.mockResolvedValue({
      config,
      draft: {
        ...config,
        testedReady: true,
        testedAt: "2026-08-25T00:00:00.000Z",
        keyChanged: true,
      },
      effective,
    });
    api.testPlatformAi.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          failProbe = () => reject(new Error("模拟测试失败"));
        }),
    );

    render(
      <PlatformAiConfigPanel rootRole="rootSuperAdmin" onNotice={onNotice} />,
    );
    const endpoint = await screen.findByDisplayValue(longEndpoint);
    const testButton = screen.getByRole("button", { name: "测试待测配置" });
    const saveButton = screen.getByRole("button", { name: "保存待测配置" });
    const activateButton = screen.getByRole("button", {
      name: "启用已测试配置",
    });
    await waitFor(() => expect(testButton).toBeEnabled());
    expect(activateButton).toBeEnabled();
    await user.click(testButton);

    await waitFor(() => expect(testButton).toBeDisabled());
    expect(endpoint).toBeDisabled();
    expect(saveButton).toBeDisabled();
    expect(activateButton).toBeDisabled();
    await user.click(testButton);
    await user.click(saveButton);
    await user.click(activateButton);
    expect(api.testPlatformAi).toHaveBeenCalledTimes(1);
    expect(api.saveManagedPlatformRouterConfig).not.toHaveBeenCalled();
    expect(api.activateManagedPlatformRouterConfig).not.toHaveBeenCalled();

    failProbe();
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("模拟测试失败"));
    expect(endpoint).toBeEnabled();
    expect(saveButton).toBeEnabled();
    expect(testButton).toBeEnabled();
    expect(activateButton).toBeEnabled();
  });

  it.each([
    ["保存", "保存待测配置"],
    ["启用", "启用已测试配置"],
  ] as const)(
    "%s运行时拒绝并发 mutation，并在失败后解锁",
    async (action, actionName) => {
      const user = userEvent.setup();
      const onNotice = vi.fn();
      let failAction = () => {};
      api.getManagedPlatformRouterState.mockResolvedValue({
        config,
        draft: {
          ...config,
          testedReady: true,
          testedAt: "2026-08-25T00:00:00.000Z",
          keyChanged: true,
        },
        effective,
      });
      const actionMock =
        action === "保存"
          ? api.saveManagedPlatformRouterConfig
          : api.activateManagedPlatformRouterConfig;
      actionMock.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            failAction = () => reject(new Error(`模拟${action}失败`));
          }),
      );

      render(
        <PlatformAiConfigPanel rootRole="rootSuperAdmin" onNotice={onNotice} />,
      );
      const endpoint = await screen.findByDisplayValue(longEndpoint);
      const saveButton = screen.getByRole("button", { name: "保存待测配置" });
      const testButton = screen.getByRole("button", { name: "测试待测配置" });
      const activateButton = screen.getByRole("button", {
        name: "启用已测试配置",
      });
      await waitFor(() => expect(activateButton).toBeEnabled());
      await user.click(screen.getByRole("button", { name: actionName }));

      await waitFor(() => expect(endpoint).toBeDisabled());
      expect(saveButton).toBeDisabled();
      expect(testButton).toBeDisabled();
      expect(activateButton).toBeDisabled();
      await user.click(saveButton);
      await user.click(testButton);
      await user.click(activateButton);
      expect(api.saveManagedPlatformRouterConfig).toHaveBeenCalledTimes(
        action === "保存" ? 1 : 0,
      );
      expect(api.testPlatformAi).not.toHaveBeenCalled();
      expect(api.activateManagedPlatformRouterConfig).toHaveBeenCalledTimes(
        action === "启用" ? 1 : 0,
      );

      failAction();
      await waitFor(() =>
        expect(onNotice).toHaveBeenCalledWith(`模拟${action}失败`),
      );
      expect(endpoint).toBeEnabled();
      expect(saveButton).toBeEnabled();
      expect(testButton).toBeEnabled();
      expect(activateButton).toBeEnabled();
    },
  );

  it("treats committed 202 save metadata as success and applies returned state", async () => {
    const user = userEvent.setup();
    const onNotice = vi.fn();
    const committedDraft = {
      ...config,
      endpoint: "https://tokenrhythm.studio",
      testedReady: false,
      testedAt: null,
      keyChanged: true,
    };
    api.saveManagedPlatformRouterConfig.mockResolvedValue({
      config,
      draft: committedDraft,
      effective,
      requestId: "request-stage-pending",
      committed: true,
      auditPending: true,
      maintenancePending: false,
      generationId: "generation-stage-pending",
    });

    render(
      <PlatformAiConfigPanel rootRole="rootSuperAdmin" onNotice={onNotice} />,
    );
    await screen.findByDisplayValue(longEndpoint);
    await user.click(screen.getByRole("button", { name: "保存待测配置" }));

    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith("已提交，审计待重放"),
    );
    expect(screen.getByDisplayValue("https://tokenrhythm.studio")).toBeEnabled();
    expect(onNotice).not.toHaveBeenCalledWith(expect.stringContaining("失败"));
  });

  it("treats committed 202 candidate testing as success and refreshes attested state", async () => {
    const user = userEvent.setup();
    const onNotice = vi.fn();
    const testedDraft = {
      ...config,
      testedReady: true,
      testedAt: "2026-08-25T00:00:00.000Z",
      keyChanged: true,
    };
    api.testPlatformAi.mockResolvedValue({
      status: "ready",
      outcome: "ready",
      phase: "response",
      model: "test-model",
      responseStatus: 200,
      latencyMs: 800,
      firstByteLatencyMs: 700,
      performanceBudgetMs: 4_000,
      hardTimeoutMs: 20_000,
      message: "模型网关连接正常。",
      requestId: "request-test-pending",
      committed: true,
      auditPending: false,
      maintenancePending: true,
      generationId: "generation-test-pending",
      config,
      draft: testedDraft,
      effective,
    });
    api.getManagedPlatformRouterState.mockResolvedValueOnce({
      config,
      draft: { ...config, testedReady: false, testedAt: null, keyChanged: true },
      effective,
    });

    render(
      <PlatformAiConfigPanel rootRole="rootSuperAdmin" onNotice={onNotice} />,
    );
    const testButton = await screen.findByRole("button", {
      name: "测试待测配置",
    });
    await waitFor(() => expect(testButton).toBeEnabled());
    await user.click(testButton);

    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith("已提交，后台清理待完成"),
    );
    expect(
      screen.getByRole("button", { name: "启用已测试配置" }),
    ).toBeEnabled();
    expect(onNotice).not.toHaveBeenCalledWith(expect.stringContaining("失败"));
    expect(api.testPlatformAi).toHaveBeenCalledWith({ candidate: true });
    expect(api.getManagedPlatformRouterState).toHaveBeenCalledTimes(1);
  });

  it("does not fabricate a managed conflict from unreadable null fields", async () => {
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

    render(
      <PlatformAiConfigPanel rootRole="rootAdmin" onNotice={vi.fn()} />,
    );
    await screen.findByText(/AI 流量已阻塞/);
    expect(screen.queryByText(/非秘密配置存在冲突/)).not.toBeInTheDocument();
  });

  it("requires manual model entry, shows protocol-specific help, and never offers model discovery", async () => {
    const user = userEvent.setup();
    render(
      <PlatformAiConfigPanel rootRole="rootSuperAdmin" onNotice={vi.fn()} />,
    );

    const modelInput = await screen.findByLabelText("模型 ID");
    const endpointInput = screen.getByLabelText("模型网关 API 基址");
    expect(modelInput).toHaveValue("test-model");
    expect(modelInput).toBeRequired();
    expect(endpointInput).toBeRequired();
    expect(
      screen.queryByRole("button", { name: /获取模型列表/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "模型 ID" })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("协议"), "anthropic-messages");
    expect(
      screen.getByText(/Anthropic 官方 API 使用 https:\/\/api\.anthropic\.com/),
    ).toBeVisible();
    expect(screen.getByLabelText("模型 ID")).toHaveAttribute(
      "placeholder",
      "claude-…",
    );
  });

  it("keeps the API key write-only while saving the manually entered model", async () => {
    const user = userEvent.setup();
    api.saveManagedPlatformRouterConfig.mockResolvedValue({
      config,
      draft: { ...config, model: "manual-provider-model", testedReady: false },
      effective,
    });
    render(
      <PlatformAiConfigPanel rootRole="rootSuperAdmin" onNotice={vi.fn()} />,
    );

    const keyInput = await screen.findByLabelText("API Key");
    const modelInput = screen.getByLabelText("模型 ID");
    expect(keyInput).toHaveValue("");
    await user.clear(modelInput);
    await user.type(modelInput, "manual-provider-model");
    await user.type(keyInput, "write-only-new-key");
    await user.click(screen.getByRole("button", { name: "保存待测配置" }));

    await waitFor(() =>
      expect(api.saveManagedPlatformRouterConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          model: "manual-provider-model",
          apiKey: "write-only-new-key",
        }),
      ),
    );
    expect(keyInput).toHaveValue("");
  });

  it("stages without replacing active config and enables only an attested draft", async () => {
    const user = userEvent.setup();
    const onNotice = vi.fn();
    const testedDraft = {
      ...config,
      endpoint: "https://tokenrhythm.studio",
      model: "deepseek-v4-flash-0731",
      testedReady: true,
      testedAt: "2026-08-24T00:00:00.000Z",
      keyChanged: true,
    };
    api.saveManagedPlatformRouterConfig.mockResolvedValue({
      config,
      draft: testedDraft,
      effective,
    });
    api.activateManagedPlatformRouterConfig.mockResolvedValue({
      config: {
        ...testedDraft,
        credentialConfigured: true,
      },
      draft: null,
      effective: { ...effective, ready: true, code: "ready", issues: [] },
    });

    render(
      <PlatformAiConfigPanel rootRole="rootSuperAdmin" onNotice={onNotice} />,
    );
    await screen.findByDisplayValue(longEndpoint);
    await user.click(screen.getByRole("button", { name: "保存待测配置" }));

    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(
        "待测配置已保存；当前生效配置未改变，请继续测试连接",
      ),
    );
    expect(api.saveManagedPlatformRouterConfig).toHaveBeenCalled();
    const activate = screen.getByRole("button", {
      name: "启用已测试配置",
    });
    expect(activate).toBeEnabled();
    await user.click(activate);
    await waitFor(() =>
      expect(api.activateManagedPlatformRouterConfig).toHaveBeenCalledTimes(1),
    );
  });
});

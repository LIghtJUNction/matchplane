import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  activateManagedPlatformRouterConfig: vi.fn(),
  getManagedPlatformRouterState: vi.fn(),
  listManagedPlatformRouterModels: vi.fn(),
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
  endpointMatchesRequired: false,
  modelMatchesRequired: false,
  protocolMatchesRequired: true,
  requiredEndpoint: "https://api.lmm.best/v1",
  requiredModel: "gpt-5.6-sol",
  issues: ["endpoint_mismatch", "model_mismatch"],
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
  it("reports a slow candidate honestly and keeps the active config available", async () => {
    const user = userEvent.setup();
    const onNotice = vi.fn();
    api.testPlatformAi.mockResolvedValue({
      status: "slow",
      outcome: "slow",
      phase: "first_byte",
      model: "test-model",
      responseStatus: 200,
      latencyMs: 9_200,
      firstByteLatencyMs: 9_100,
      performanceBudgetMs: 4_000,
      hardTimeoutMs: 20_000,
      message: "模型网关可达，但响应较慢。",
    });

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

  it("stages without replacing active config and enables only an attested draft", async () => {
    const user = userEvent.setup();
    const onNotice = vi.fn();
    const testedDraft = {
      ...config,
      endpoint: "https://api.lmm.best/v1",
      model: "gpt-5.6-sol",
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

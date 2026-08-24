import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getManagedPlatformRouterConfig: vi.fn(),
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

beforeEach(() => {
  api.getManagedPlatformRouterConfig.mockReset();
  api.listManagedPlatformRouterModels.mockReset();
  api.saveManagedPlatformRouterConfig.mockReset();
  api.testPlatformAi.mockReset();
  api.getManagedPlatformRouterConfig.mockResolvedValue({
    endpoint: longEndpoint,
    model: "test-model",
    protocol: "openai-compatible",
    enabled: true,
    credentialConfigured: true,
    assistantInstructions: "",
    assistantMaxOutputTokens: 320,
    assistantTemperature: 0.2,
    assistantMaxSteps: 3,
    assistantTimeoutMs: 20_000,
    assistantReasoningEffort: "none",
    modelReasoningEfforts: [],
  });
});

describe("PlatformAiConfigPanel connection probe", () => {
  it("reports a slow non-ready result honestly and keeps long endpoints bounded", async () => {
    const user = userEvent.setup();
    const onNotice = vi.fn();
    api.testPlatformAi.mockResolvedValue({
      status: "failed",
      model: "test-model",
      responseStatus: 504,
      latencyMs: 20_000,
      message: "模型在 20000 ms 内没有完成响应，请检查超时设置后重试。",
    });

    const { container } = render(
      <PlatformAiConfigPanel
        rootRole="rootSuperAdmin"
        onNotice={onNotice}
      />,
    );

    const endpoint = await screen.findByDisplayValue(longEndpoint);
    expect(endpoint.closest(".platform-ai-endpoint-field")).not.toBeNull();
    expect(container.querySelector(".platform-ai-config")).toContainElement(endpoint);

    const testButton = screen.getByRole("button", { name: "测试连接" });
    await waitFor(() => expect(testButton).toBeEnabled());
    await user.click(testButton);

    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(
        "模型在 20000 ms 内没有完成响应，请检查超时设置后重试。",
      ),
    );
    expect(onNotice).not.toHaveBeenCalledWith("AI 连接测试成功");
  });
});

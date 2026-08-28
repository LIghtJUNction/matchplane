import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getMallExchangeRateSettings: vi.fn(),
  saveMallExchangeRateSettings: vi.fn(),
  syncLatestUsdExchangeRate: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  ...api,
}));

import { MallCurrencySettingsPanel } from "./MallCurrencySettingsPanel";

const onNotice = vi.fn();

function settings(
  overrides: Partial<
    Awaited<ReturnType<typeof api.getMallExchangeRateSettings>>
  > = {},
) {
  return {
    baseCurrency: "USD" as const,
    localCurrency: "CNY",
    usdToLocalRate: 7.2,
    rateSource: "api.frankfurter.app",
    rateUpdatedAt: "2026-08-28T05:00:00.000Z",
    version: 3,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getMallExchangeRateSettings.mockResolvedValue(settings());
  api.saveMallExchangeRateSettings.mockResolvedValue(settings({ version: 4 }));
  api.syncLatestUsdExchangeRate.mockResolvedValue(
    settings({ localCurrency: "JPY", usdToLocalRate: 146.12, version: 4 }),
  );
});

describe("MallCurrencySettingsPanel", () => {
  it("shows the selected local currency and the latest USD rate", async () => {
    render(
      <MallCurrencySettingsPanel
        rootRole="rootSuperAdmin"
        onNotice={onNotice}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("正在读取货币设置");
    expect(await screen.findByTestId("usd-exchange-rate")).toHaveTextContent(
      "1 USD = 7.2 CNY",
    );
    expect(screen.getByLabelText("本地货币")).toHaveValue("CNY");
    expect(screen.getByText(/来源：api\.frankfurter\.app/)).toBeInTheDocument();
  });

  it("saves a changed local currency and clears its stale rate", async () => {
    const user = userEvent.setup();
    api.saveMallExchangeRateSettings.mockResolvedValue(
      settings({
        localCurrency: "EUR",
        usdToLocalRate: null,
        rateSource: null,
        rateUpdatedAt: null,
        version: 4,
      }),
    );
    render(
      <MallCurrencySettingsPanel
        rootRole="rootSuperAdmin"
        onNotice={onNotice}
      />,
    );

    await screen.findByTestId("usd-exchange-rate");
    await user.selectOptions(screen.getByLabelText("本地货币"), "EUR");
    await user.click(screen.getByRole("button", { name: "保存本地货币" }));

    await waitFor(() =>
      expect(api.saveMallExchangeRateSettings).toHaveBeenCalledWith({
        localCurrency: "EUR",
        expectedVersion: 3,
      }),
    );
    expect(await screen.findByTestId("usd-exchange-rate")).toHaveTextContent(
      "尚未同步汇率",
    );
    expect(onNotice).toHaveBeenCalledWith("本地货币已保存；请同步最新美元汇率");
  });

  it("syncs the latest rate for a newly selected currency in one action", async () => {
    const user = userEvent.setup();
    render(
      <MallCurrencySettingsPanel
        rootRole="rootSuperAdmin"
        onNotice={onNotice}
      />,
    );

    await screen.findByTestId("usd-exchange-rate");
    await user.selectOptions(screen.getByLabelText("本地货币"), "JPY");
    await user.click(screen.getByRole("button", { name: "同步最新美元汇率" }));

    await waitFor(() =>
      expect(api.syncLatestUsdExchangeRate).toHaveBeenCalledWith({
        localCurrency: "JPY",
        expectedVersion: 3,
      }),
    );
    expect(await screen.findByTestId("usd-exchange-rate")).toHaveTextContent(
      "1 USD = 146.12 JPY",
    );
    expect(onNotice).toHaveBeenCalledWith("美元/JPY 汇率已同步");
  });

  it("reloads settings after a save version conflict", async () => {
    const user = userEvent.setup();
    api.getMallExchangeRateSettings
      .mockResolvedValueOnce(settings())
      .mockResolvedValueOnce(
        settings({
          localCurrency: "EUR",
          usdToLocalRate: null,
          rateSource: null,
          rateUpdatedAt: null,
          version: 8,
        }),
      );
    api.saveMallExchangeRateSettings.mockRejectedValue(
      Object.assign(new Error("货币设置已被其他人更新，请刷新后重试"), {
        status: 409,
      }),
    );
    render(
      <MallCurrencySettingsPanel
        rootRole="rootSuperAdmin"
        onNotice={onNotice}
      />,
    );

    await screen.findByTestId("usd-exchange-rate");
    await user.selectOptions(screen.getByLabelText("本地货币"), "EUR");
    await user.click(screen.getByRole("button", { name: "保存本地货币" }));

    await waitFor(() =>
      expect(api.getMallExchangeRateSettings).toHaveBeenCalledTimes(2),
    );
    expect(screen.getByLabelText("本地货币")).toHaveValue("EUR");
    expect(api.saveMallExchangeRateSettings).toHaveBeenCalledWith({
      localCurrency: "EUR",
      expectedVersion: 3,
    });
  });

  it("reloads settings after a sync version conflict", async () => {
    const user = userEvent.setup();
    api.getMallExchangeRateSettings
      .mockResolvedValueOnce(settings())
      .mockResolvedValueOnce(settings({ localCurrency: "JPY", version: 9 }));
    api.syncLatestUsdExchangeRate.mockRejectedValue(
      Object.assign(new Error("货币设置已被其他人更新，请刷新后重试"), {
        status: 409,
      }),
    );
    render(
      <MallCurrencySettingsPanel
        rootRole="rootSuperAdmin"
        onNotice={onNotice}
      />,
    );

    await screen.findByTestId("usd-exchange-rate");
    await user.selectOptions(screen.getByLabelText("本地货币"), "JPY");
    await user.click(screen.getByRole("button", { name: "同步最新美元汇率" }));

    await waitFor(() =>
      expect(api.getMallExchangeRateSettings).toHaveBeenCalledTimes(2),
    );
    expect(screen.getByLabelText("本地货币")).toHaveValue("JPY");
    expect(api.syncLatestUsdExchangeRate).toHaveBeenCalledWith({
      localCurrency: "JPY",
      expectedVersion: 3,
    });
  });

  it("does not offer currencies unsupported by the default Frankfurter provider", async () => {
    render(
      <MallCurrencySettingsPanel
        rootRole="rootSuperAdmin"
        onNotice={onNotice}
      />,
    );

    await screen.findByTestId("usd-exchange-rate");
    expect(screen.queryByRole("option", { name: /新台币/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /越南盾/ })).not.toBeInTheDocument();
  });

  it("keeps the settings read-only for non-owners", async () => {
    render(
      <MallCurrencySettingsPanel
        rootRole="platformAdmin"
        onNotice={onNotice}
      />,
    );

    await screen.findByTestId("usd-exchange-rate");
    expect(screen.getByLabelText("本地货币")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "同步最新美元汇率" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存本地货币" })).toBeDisabled();
  });
});

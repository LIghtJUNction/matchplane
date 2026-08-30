import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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

  it("presents the USD identity source as a fixed baseline", async () => {
    api.getMallExchangeRateSettings.mockResolvedValue(
      settings({
        localCurrency: "USD",
        usdToLocalRate: 1,
        rateSource: "identity",
      }),
    );
    render(
      <MallCurrencySettingsPanel
        rootRole="rootSuperAdmin"
        onNotice={onNotice}
      />,
    );

    expect(await screen.findByTestId("usd-exchange-rate")).toHaveTextContent(
      "1 USD = 1 USD",
    );
    expect(screen.getByText(/来源：USD 基准值（固定 1:1）/)).toBeInTheDocument();
    expect(screen.queryByText(/来源：identity/)).not.toBeInTheDocument();
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

  it("keeps focus and the draft mounted while rebasing after a save conflict", async () => {
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
    api.saveMallExchangeRateSettings
      .mockRejectedValueOnce(
        Object.assign(new Error("货币设置已被其他人更新，请刷新后重试"), {
          status: 409,
        }),
      )
      .mockResolvedValueOnce(settings({ localCurrency: "JPY", version: 9 }));
    render(
      <MallCurrencySettingsPanel
        rootRole="rootSuperAdmin"
        onNotice={onNotice}
      />,
    );

    await screen.findByTestId("usd-exchange-rate");
    const currencySelect = screen.getByLabelText("本地货币");
    await user.selectOptions(currencySelect, "JPY");
    currencySelect.focus();
    const form = screen
      .getByRole("button", { name: "保存本地货币" })
      .closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    await waitFor(() =>
      expect(api.getMallExchangeRateSettings).toHaveBeenCalledTimes(2),
    );
    expect(screen.getByLabelText("本地货币")).toBe(currencySelect);
    expect(currencySelect).toHaveFocus();
    expect(currencySelect).toHaveValue("JPY");
    expect(screen.getByRole("status")).toHaveTextContent(
      "已载入最新设置，请确认后重试",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "已载入最新设置，请确认草稿后重试",
    );
    expect(api.saveMallExchangeRateSettings).toHaveBeenNthCalledWith(1, {
      localCurrency: "JPY",
      expectedVersion: 3,
    });

    await user.click(screen.getByRole("button", { name: "重试保存" }));
    await waitFor(() =>
      expect(api.saveMallExchangeRateSettings).toHaveBeenNthCalledWith(2, {
        localCurrency: "JPY",
        expectedVersion: 8,
      }),
    );
  });

  it("ignores an older GET that resolves after a newer load", async () => {
    const user = userEvent.setup();
    const firstLoad = deferred<ReturnType<typeof settings>>();
    const secondLoad = deferred<ReturnType<typeof settings>>();
    const nextNotice = vi.fn();
    api.getMallExchangeRateSettings
      .mockReset()
      .mockReturnValueOnce(firstLoad.promise)
      .mockReturnValueOnce(secondLoad.promise);

    const { rerender } = render(
      <MallCurrencySettingsPanel
        rootRole="rootSuperAdmin"
        onNotice={onNotice}
      />,
    );
    rerender(
      <MallCurrencySettingsPanel
        rootRole="rootSuperAdmin"
        onNotice={nextNotice}
      />,
    );

    await waitFor(() =>
      expect(api.getMallExchangeRateSettings).toHaveBeenCalledTimes(2),
    );
    await act(async () => {
      secondLoad.resolve(settings({ localCurrency: "JPY", version: 9 }));
      await secondLoad.promise;
    });
    expect(await screen.findByLabelText("本地货币")).toHaveValue("JPY");

    await act(async () => {
      firstLoad.resolve(settings({ localCurrency: "CNY", version: 3 }));
      await firstLoad.promise;
    });
    expect(screen.getByLabelText("本地货币")).toHaveValue("JPY");

    await user.click(screen.getByRole("button", { name: "同步最新美元汇率" }));
    await waitFor(() =>
      expect(api.syncLatestUsdExchangeRate).toHaveBeenCalledWith({
        localCurrency: "JPY",
        expectedVersion: 9,
      }),
    );
  });

  it("blocks every write entry while a refresh is loading and writes with the refreshed version", async () => {
    const user = userEvent.setup();
    const reload = deferred<ReturnType<typeof settings>>();
    api.saveMallExchangeRateSettings.mockRejectedValueOnce(
      new Error("本地货币保存失败，请稍后重试"),
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
    await screen.findByRole("alert");
    api.getMallExchangeRateSettings.mockReturnValueOnce(reload.promise);

    await user.click(screen.getByRole("button", { name: "重新读取" }));

    const retrySave = screen.getByRole("button", { name: "重试保存" });
    const reloadButton = screen.getByRole("button", { name: "重新读取" });
    const saveButton = screen.getByRole("button", { name: "保存本地货币" });
    const syncButton = screen.getByRole("button", {
      name: "同步最新美元汇率",
    });
    expect(screen.getByLabelText("本地货币")).toBeDisabled();
    expect(retrySave).toBeDisabled();
    expect(reloadButton).toBeDisabled();
    expect(saveButton).toBeDisabled();
    expect(syncButton).toBeDisabled();

    fireEvent.click(retrySave);
    fireEvent.click(saveButton);
    fireEvent.submit(saveButton.closest("form")!);
    fireEvent.click(syncButton);
    expect(api.saveMallExchangeRateSettings).toHaveBeenCalledTimes(1);
    expect(api.syncLatestUsdExchangeRate).not.toHaveBeenCalled();

    await act(async () => {
      reload.resolve(settings({ localCurrency: "JPY", version: 8 }));
      await reload.promise;
    });
    await user.click(screen.getByRole("button", { name: "保存本地货币" }));
    await waitFor(() =>
      expect(api.saveMallExchangeRateSettings).toHaveBeenNthCalledWith(2, {
        localCurrency: "EUR",
        expectedVersion: 8,
      }),
    );
  });

  it("renders distinct unknown draft and server currencies after a conflict", async () => {
    const user = userEvent.setup();
    api.getMallExchangeRateSettings
      .mockResolvedValueOnce(settings({ localCurrency: "XTS" }))
      .mockResolvedValueOnce(settings({ localCurrency: "XDR", version: 8 }));
    api.syncLatestUsdExchangeRate
      .mockRejectedValueOnce(
        Object.assign(new Error("货币设置已被其他人更新，请刷新后重试"), {
          status: 409,
        }),
      )
      .mockResolvedValueOnce(settings({ localCurrency: "XTS", version: 9 }));
    render(
      <MallCurrencySettingsPanel
        rootRole="rootSuperAdmin"
        onNotice={onNotice}
      />,
    );

    expect(await screen.findByLabelText("本地货币")).toHaveValue("XTS");
    await user.click(screen.getByRole("button", { name: "同步最新美元汇率" }));

    await waitFor(() =>
      expect(api.getMallExchangeRateSettings).toHaveBeenCalledTimes(2),
    );
    const currencySelect = screen.getByLabelText("本地货币");
    expect(currencySelect).toHaveValue("XTS");
    expect(
      screen.getByRole("option", { name: "XTS（未保存草稿）" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "XDR（当前设置）" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重试同步" }));
    await waitFor(() =>
      expect(api.syncLatestUsdExchangeRate).toHaveBeenNthCalledWith(2, {
        localCurrency: "XTS",
        expectedVersion: 8,
      }),
    );
  });

  it("reloads settings after a sync version conflict", async () => {
    const user = userEvent.setup();
    api.getMallExchangeRateSettings
      .mockResolvedValueOnce(settings())
      .mockResolvedValueOnce(settings({ localCurrency: "JPY", version: 9 }));
    api.syncLatestUsdExchangeRate
      .mockRejectedValueOnce(
        Object.assign(new Error("货币设置已被其他人更新，请刷新后重试"), {
          status: 409,
        }),
      )
      .mockResolvedValueOnce(
        settings({ localCurrency: "JPY", usdToLocalRate: 146.12, version: 10 }),
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
    expect(api.syncLatestUsdExchangeRate).toHaveBeenNthCalledWith(1, {
      localCurrency: "JPY",
      expectedVersion: 3,
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "已载入最新设置，请确认草稿后重试",
    );
    await user.click(screen.getByRole("button", { name: "重试同步" }));
    await waitFor(() =>
      expect(api.syncLatestUsdExchangeRate).toHaveBeenNthCalledWith(2, {
        localCurrency: "JPY",
        expectedVersion: 9,
      }),
    );
  });

  it("keeps save failures in the panel until retry succeeds", async () => {
    const user = userEvent.setup();
    api.saveMallExchangeRateSettings
      .mockRejectedValueOnce(new Error("本地货币保存失败，请稍后重试"))
      .mockResolvedValueOnce(
        settings({ localCurrency: "EUR", usdToLocalRate: null, version: 4 }),
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

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "本地货币保存失败，请稍后重试",
    );
    expect(screen.getByRole("button", { name: "重试保存" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "重新读取" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "重试保存" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(api.saveMallExchangeRateSettings).toHaveBeenCalledTimes(2);
  });

  it("keeps sync failures in the panel until retry succeeds", async () => {
    const user = userEvent.setup();
    api.syncLatestUsdExchangeRate
      .mockRejectedValueOnce(new Error("最新美元汇率同步失败，请稍后重试"))
      .mockResolvedValueOnce(
        settings({ localCurrency: "JPY", usdToLocalRate: 146.12, version: 4 }),
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

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "最新美元汇率同步失败，请稍后重试",
    );
    expect(screen.getByRole("button", { name: "重试同步" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "重新读取" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "重试同步" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(api.syncLatestUsdExchangeRate).toHaveBeenCalledTimes(2);
  });

  it("offers every currency supported by the default Frankfurter provider", async () => {
    render(
      <MallCurrencySettingsPanel
        rootRole="rootSuperAdmin"
        onNotice={onNotice}
      />,
    );

    await screen.findByTestId("usd-exchange-rate");
    const currencyCodes = screen
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value)
      .sort();
    expect(currencyCodes).toEqual(
      [
        "AUD",
        "BRL",
        "CAD",
        "CHF",
        "CNY",
        "CZK",
        "DKK",
        "EUR",
        "GBP",
        "HKD",
        "HUF",
        "IDR",
        "ILS",
        "INR",
        "ISK",
        "JPY",
        "KRW",
        "MXN",
        "MYR",
        "NOK",
        "NZD",
        "PHP",
        "PLN",
        "RON",
        "SEK",
        "SGD",
        "THB",
        "TRY",
        "USD",
        "ZAR",
      ].sort(),
    );
  });

  it("prevents a non-owner from triggering save and sync retries", async () => {
    const user = userEvent.setup();
    api.saveMallExchangeRateSettings.mockRejectedValueOnce(
      new Error("保存失败"),
    );
    api.syncLatestUsdExchangeRate.mockRejectedValueOnce(
      new Error("同步失败"),
    );
    const { rerender } = render(
      <MallCurrencySettingsPanel
        rootRole="rootSuperAdmin"
        onNotice={onNotice}
      />,
    );

    await screen.findByTestId("usd-exchange-rate");
    await user.selectOptions(screen.getByLabelText("本地货币"), "EUR");
    await user.click(screen.getByRole("button", { name: "保存本地货币" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("保存失败");

    rerender(
      <MallCurrencySettingsPanel
        rootRole="platformAdmin"
        onNotice={onNotice}
      />,
    );
    const retrySave = screen.getByRole("button", { name: "重试保存" });
    expect(retrySave).toBeDisabled();
    fireEvent.click(retrySave);
    expect(api.saveMallExchangeRateSettings).toHaveBeenCalledTimes(1);

    rerender(
      <MallCurrencySettingsPanel
        rootRole="rootSuperAdmin"
        onNotice={onNotice}
      />,
    );
    await user.click(screen.getByRole("button", { name: "同步最新美元汇率" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("同步失败");

    rerender(
      <MallCurrencySettingsPanel
        rootRole="platformAdmin"
        onNotice={onNotice}
      />,
    );
    const retrySync = screen.getByRole("button", { name: "重试同步" });
    expect(retrySync).toBeDisabled();
    fireEvent.click(retrySync);
    expect(api.syncLatestUsdExchangeRate).toHaveBeenCalledTimes(1);
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

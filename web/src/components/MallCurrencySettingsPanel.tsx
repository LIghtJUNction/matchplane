"use client";

import { RefreshCw, Save } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  getMallExchangeRateSettings,
  MarketplaceApiError,
  saveMallExchangeRateSettings,
  syncLatestUsdExchangeRate,
  type MallExchangeRateSettings,
} from "../api";
import { SectionHeading } from "./Primitives";

// Keep this list aligned with Frankfurter's ECB-backed /currencies response. Unknown persisted
// codes remain visible below so an existing tenant can still be corrected rather than silently
// changing its setting.
type PanelError = {
  message: string;
  retry: "load" | "save" | "sync";
};

const LOCAL_CURRENCY_OPTIONS = [
  ["CNY", "人民币"],
  ["JPY", "日元"],
  ["KRW", "韩元"],
  ["HKD", "港币"],
  ["SGD", "新加坡元"],
  ["USD", "美元"],
  ["EUR", "欧元"],
  ["GBP", "英镑"],
  ["AUD", "澳大利亚元"],
  ["CAD", "加拿大元"],
  ["CHF", "瑞士法郎"],
  ["CZK", "捷克克朗"],
  ["HUF", "匈牙利福林"],
  ["ILS", "以色列新谢克尔"],
  ["INR", "印度卢比"],
  ["IDR", "印度尼西亚卢比"],
  ["ISK", "冰岛克朗"],
  ["MYR", "马来西亚林吉特"],
  ["THB", "泰铢"],
  ["PHP", "菲律宾比索"],
  ["NZD", "新西兰元"],
  ["NOK", "挪威克朗"],
  ["SEK", "瑞典克朗"],
  ["DKK", "丹麦克朗"],
  ["PLN", "波兰兹罗提"],
  ["MXN", "墨西哥比索"],
  ["RON", "罗马尼亚列伊"],
  ["TRY", "土耳其里拉"],
  ["BRL", "巴西雷亚尔"],
  ["ZAR", "南非兰特"],
] as const;

export function MallCurrencySettingsPanel({
  rootRole,
  onNotice,
}: {
  rootRole?: string | null;
  onNotice: (message: string) => void;
}) {
  const canEdit = rootRole === "rootSuperAdmin";
  const [settings, setSettings] = useState<MallExchangeRateSettings | null>(
    null,
  );
  const [localCurrency, setLocalCurrency] = useState("CNY");
  const [savedCurrency, setSavedCurrency] = useState("CNY");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [panelError, setPanelError] = useState<PanelError | null>(null);
  const latestLoadId = useRef(0);
  const loadingRef = useRef(true);
  const savingRef = useRef(false);
  const syncingRef = useRef(false);

  const applySettings = useCallback(
    (
      next: MallExchangeRateSettings,
      options: { preserveDraft?: boolean; submittedCurrency?: string } = {},
    ) => {
      setSettings(next);
      setSavedCurrency(next.localCurrency);
      setLocalCurrency((current) => {
        if (options.preserveDraft) return current;
        if (
          options.submittedCurrency &&
          current !== options.submittedCurrency
        ) {
          return current;
        }
        return next.localCurrency;
      });
    },
    [],
  );

  const load = useCallback(
    async ({
      preserveDraft = false,
      successAnnouncement = "",
    }: {
      preserveDraft?: boolean;
      successAnnouncement?: string;
    } = {}) => {
      const loadId = ++latestLoadId.current;
      loadingRef.current = true;
      setLoading(true);
      try {
        const next = await getMallExchangeRateSettings();
        if (loadId !== latestLoadId.current) return false;
        applySettings(next, { preserveDraft });
        setPanelError(null);
        setAnnouncement(successAnnouncement);
        return true;
      } catch (error) {
        if (loadId !== latestLoadId.current) return false;
        const message =
          error instanceof Error ? error.message : "货币设置读取失败";
        setPanelError({ message, retry: "load" });
        setAnnouncement("");
        onNotice(message);
        return false;
      } finally {
        if (loadId === latestLoadId.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [applySettings, onNotice],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const recoverFromConflict = async (
    errorMessage: string,
    retry: Exclude<PanelError["retry"], "load">,
  ) => {
    setPanelError({ message: errorMessage, retry });
    const loaded = await load({
      preserveDraft: true,
      successAnnouncement: "已载入最新设置，请确认后重试",
    });
    if (loaded) {
      setPanelError({
        message: `${errorMessage}。已载入最新设置，请确认草稿后重试。`,
        retry,
      });
    }
  };

  const saveCurrency = async () => {
    if (
      !canEdit ||
      !settings ||
      loadingRef.current ||
      savingRef.current ||
      syncingRef.current
    ) {
      return;
    }
    if (localCurrency === savedCurrency) {
      setPanelError((current) =>
        current?.retry === "save" ? null : current,
      );
      setAnnouncement("");
      onNotice("本地货币没有变化");
      return;
    }
    const submittedCurrency = localCurrency;
    savingRef.current = true;
    setSaving(true);
    setAnnouncement("");
    try {
      const next = await saveMallExchangeRateSettings({
        localCurrency: submittedCurrency,
        expectedVersion: settings.version,
      });
      applySettings(next, { submittedCurrency });
      setPanelError(null);
      onNotice("本地货币已保存；请同步最新美元汇率");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "本地货币保存失败";
      if (isVersionConflict(error)) {
        onNotice(message);
        await recoverFromConflict(message, "save");
      } else {
        setPanelError({ message, retry: "save" });
        onNotice(message);
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const sync = async () => {
    if (
      !canEdit ||
      !settings ||
      loadingRef.current ||
      savingRef.current ||
      syncingRef.current
    ) {
      return;
    }
    const submittedCurrency = localCurrency;
    syncingRef.current = true;
    setSyncing(true);
    setAnnouncement("");
    try {
      const next = await syncLatestUsdExchangeRate({
        localCurrency: submittedCurrency,
        expectedVersion: settings.version,
      });
      applySettings(next, { submittedCurrency });
      setPanelError(null);
      onNotice(`美元/${next.localCurrency} 汇率已同步`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "最新美元汇率同步失败";
      if (isVersionConflict(error)) {
        onNotice(message);
        await recoverFromConflict(message, "sync");
      } else {
        setPanelError({ message, retry: "sync" });
        onNotice(message);
      }
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  };

  if (loading && !settings) {
    return (
      <section
        className="surface mall-currency-panel"
        aria-labelledby="mall-currency-title"
      >
        <SectionHeading title="货币与汇率" titleId="mall-currency-title" />
        <p className="mall-currency-status" role="status">
          正在读取货币设置…
        </p>
      </section>
    );
  }

  if (!settings) {
    return (
      <section
        className="surface mall-currency-panel"
        aria-labelledby="mall-currency-title"
      >
        <SectionHeading title="货币与汇率" titleId="mall-currency-title" />
        <div className="mall-currency-error" role="alert">
          <p>{panelError?.message || "货币设置暂时不可用"}</p>
          <button
            className="button button-light"
            type="button"
            onClick={() => void load()}
            disabled={loading}
          >
            <RefreshCw size={16} aria-hidden="true" />
            重新读取
          </button>
        </div>
      </section>
    );
  }

  const hasKnownSavedCurrency = LOCAL_CURRENCY_OPTIONS.some(
    ([code]) => code === settings.localCurrency,
  );
  const hasKnownDraftCurrency = LOCAL_CURRENCY_OPTIONS.some(
    ([code]) => code === localCurrency,
  );
  const draftCurrencyOptionLabel =
    localCurrency === settings.localCurrency
      ? `${localCurrency}（当前设置）`
      : `${localCurrency}（未保存草稿）`;
  const rate = formatRate(settings.usdToLocalRate);
  const updated = formatUpdatedAt(settings.rateUpdatedAt);
  const rateDescription =
    settings.usdToLocalRate === null
      ? "尚未同步汇率"
      : `1 USD = ${rate} ${settings.localCurrency}`;

  return (
    <section
      className="surface mall-currency-panel"
      aria-labelledby="mall-currency-title"
      aria-busy={loading || saving || syncing}
    >
      <SectionHeading title="货币与汇率" titleId="mall-currency-title" />
      <p className="mall-currency-intro">
        设置商城使用的本地货币，并从公开汇率服务同步美元参考汇率。汇率仅用于展示和换算参考。
      </p>
      <p
        className={announcement ? "mall-currency-status" : "sr-only"}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </p>
      <form
        className="mall-currency-form"
        onSubmit={(event) => {
          event.preventDefault();
          void saveCurrency();
        }}
      >
        <label className="mall-currency-field" htmlFor="mall-local-currency">
          <span>本地货币</span>
          <select
            id="mall-local-currency"
            value={localCurrency}
            aria-label="本地货币"
            disabled={!canEdit || loading}
            onChange={(event) => setLocalCurrency(event.target.value)}
            aria-describedby="mall-local-currency-hint"
          >
            {!hasKnownDraftCurrency ? (
              <option value={localCurrency}>{draftCurrencyOptionLabel}</option>
            ) : null}
            {!hasKnownSavedCurrency &&
              settings.localCurrency !== localCurrency ? (
              <option value={settings.localCurrency}>
                {settings.localCurrency}（当前设置）
              </option>
            ) : null}
            {LOCAL_CURRENCY_OPTIONS.map(([code, label]) => (
              <option key={code} value={code}>
                {label}（{code}）
              </option>
            ))}
          </select>
          <small id="mall-local-currency-hint">
            切换货币后，之前的美元汇率会被清除，需要重新同步。
          </small>
        </label>
        <div className="mall-currency-rate" aria-live="polite">
          <span>美元汇率</span>
          <strong data-testid="usd-exchange-rate">{rateDescription}</strong>
          <small>
            {updated}
            {settings.rateSource
              ? ` · 来源：${formatRateSource(settings.rateSource)}`
              : ""}
          </small>
        </div>
        {panelError ? (
          <div className="mall-currency-error" role="alert">
            <p>{panelError.message}</p>
            <div className="mall-currency-error-actions">
              {panelError.retry === "save" ? (
                <button
                  className="button button-light"
                  type="button"
                  onClick={() => void saveCurrency()}
                  disabled={!canEdit || loading || saving || syncing}
                >
                  <Save size={16} aria-hidden="true" />
                  重试保存
                </button>
              ) : null}
              {panelError.retry === "sync" ? (
                <button
                  className="button button-light"
                  type="button"
                  onClick={() => void sync()}
                  disabled={!canEdit || loading || saving || syncing}
                >
                  <RefreshCw size={16} aria-hidden="true" />
                  重试同步
                </button>
              ) : null}
              <button
                className="button button-light"
                type="button"
                onClick={() =>
                  void load({
                    preserveDraft: true,
                    successAnnouncement: "已重新读取最新设置",
                  })
                }
                disabled={loading || saving || syncing}
              >
                <RefreshCw size={16} aria-hidden="true" />
                重新读取
              </button>
            </div>
          </div>
        ) : null}
        <div className="mall-currency-actions">
          <p>
            {canEdit
              ? "同步会保存当前本地货币，并覆盖为最新参考值。"
              : "只有商城负责人可以修改货币设置。"}
          </p>
          <div>
            <button
              className="button button-light"
              type="submit"
              disabled={
                !canEdit ||
                loading ||
                saving ||
                syncing ||
                localCurrency === savedCurrency
              }
            >
              <Save size={16} aria-hidden="true" />
              {saving ? "保存中…" : "保存本地货币"}
            </button>
            <button
              className="button button-dark"
              type="button"
              onClick={() => void sync()}
              disabled={!canEdit || loading || saving || syncing}
            >
              <RefreshCw
                size={16}
                className={
                  syncing ? "animate-spin motion-reduce:animate-none" : ""
                }
                aria-hidden="true"
              />
              {syncing ? "同步中…" : "同步最新美元汇率"}
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}

function formatRateSource(source: string): string {
  return source === "identity" ? "USD 基准值（固定 1:1）" : source;
}

function formatRate(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "—";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 8,
  }).format(rate);
}

function formatUpdatedAt(value: string | null): string {
  if (!value) return "尚未同步";
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return "同步时间未知";
  return `最近同步：${new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp)}`;
}

function isVersionConflict(error: unknown): boolean {
  return (
    (error instanceof MarketplaceApiError && error.status === 409) ||
    (typeof error === "object" &&
      error !== null &&
      "status" in error &&
      (error as { status?: unknown }).status === 409)
  );
}

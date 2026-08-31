"use client";

import { Button } from "@appica/ui-react/button";
import {
  AlertCircle,
  Check,
  Copy,
  Link2,
  RefreshCw,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
} from "react";

import {
  createStoreAcquisitionLink,
  getMarketplaceOffers,
  getStoreAcquisitionLinks,
  MarketplaceApiError,
  updateStoreAcquisitionLinkStatus,
  type MarketplaceOffer,
  type StoreAcquisitionLink,
  type StoreAcquisitionLinkConfiguredStatus,
  type StoreSummary,
} from "../api";
import { getMarketplaceSession } from "../lib/marketplace-session";
import type { InterfaceLocale } from "../lib/preferences";
import type { SubplatformConfig } from "../subplatform";
import styles from "./StoreAcquisitionLinksPanel.module.css";

const CHANNEL_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const MAX_REFERENCE_LENGTH = 128;

interface StoreAcquisitionLinksPanelProps {
  locale: InterfaceLocale;
  store: StoreSummary;
  subplatform: SubplatformConfig;
}

interface LinkActionError {
  conflict: boolean;
  message: string;
}

type CopyState = "idle" | "copied" | "error";

/** Store-manager-only channel link creation and status controls. */
export function StoreAcquisitionLinksPanel({
  locale,
  store,
  subplatform,
}: StoreAcquisitionLinksPanelProps) {
  const english = locale === "en";
  const [links, setLinks] = useState<StoreAcquisitionLink[] | null>(null);
  const [offers, setOffers] = useState<MarketplaceOffer[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [offerId, setOfferId] = useState("");
  const [channelKey, setChannelKey] = useState("");
  const [sourceRef, setSourceRef] = useState("");
  const [campaignRef, setCampaignRef] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [updatingIds, setUpdatingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [actionErrors, setActionErrors] = useState<
    Readonly<Record<string, LinkActionError>>
  >({});
  const [oneTimePath, setOneTimePath] = useState<`/r/${string}` | null>(null);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [announcement, setAnnouncement] = useState("");

  const requestVersionRef = useRef(0);
  const loadPromiseRef = useRef<Promise<void> | null>(null);
  const submittingRef = useRef(false);
  const updatingRef = useRef(new Set<string>());
  const localeRef = useRef(locale);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  const createButtonRef = useRef<HTMLButtonElement>(null);
  localeRef.current = locale;

  const resourceKey = `${store.id}:${subplatform.domainId ?? "unconfigured"}`;
  const load = useCallback((): Promise<void> => {
    if (loadPromiseRef.current) return loadPromiseRef.current;

    const requestVersion = requestVersionRef.current + 1;
    requestVersionRef.current = requestVersion;
    const request = (async () => {
      setRefreshing(true);
      setLoadError(null);
      try {
        const [nextLinks, nextOffers] = await Promise.all([
          getStoreAcquisitionLinks(store.id),
          getMarketplaceSession({
            subplatform: subplatform.slug,
            platformPath: subplatform.path,
            tenantId: subplatform.tenantId,
            domainId: subplatform.domainId,
            role: "seller",
          }).then(async (session) => {
            if (!subplatform.domainId || !session) {
              throw new Error(
                localeRef.current === "en"
                  ? "The seller session is unavailable. Reopen the store workspace and retry."
                  : "商家会话暂不可用，请重新打开店铺工作台后重试。",
              );
            }
            return getMarketplaceOffers({
              session,
              domainId: subplatform.domainId,
              limit: 100,
            });
          }),
        ]);
        if (requestVersionRef.current !== requestVersion) return;
        setLinks(nextLinks);
        setOffers(nextOffers);
        setActionErrors({});
        setAnnouncement(
          localeRef.current === "en"
            ? "Channel links are up to date."
            : "渠道链接已更新。",
        );
      } catch (cause) {
        if (requestVersionRef.current !== requestVersion) return;
        setLoadError(
          errorMessage(
            cause,
            localeRef.current,
            "Channel links could not be loaded.",
            "渠道链接暂时无法读取。",
          ),
        );
        setAnnouncement(
          localeRef.current === "en"
            ? "Channel links could not be refreshed. Retry is available."
            : "渠道链接刷新失败，可以重试。",
        );
      } finally {
        if (requestVersionRef.current === requestVersion) {
          setRefreshing(false);
        }
      }
    })();

    loadPromiseRef.current = request;
    void request.finally(() => {
      if (loadPromiseRef.current === request) loadPromiseRef.current = null;
    });
    return request;
  }, [
    store.id,
    subplatform.domainId,
    subplatform.path,
    subplatform.slug,
    subplatform.tenantId,
  ]);

  useEffect(() => {
    setLinks(null);
    setOffers([]);
    setLoadError(null);
    setActionErrors({});
    setOneTimePath(null);
    setCopyState("idle");
    setAnnouncement("");
    void load();

    return () => {
      requestVersionRef.current += 1;
      loadPromiseRef.current = null;
    };
  }, [load, resourceKey]);

  const eligibleOffers = useMemo(
    () =>
      offers.filter(
        (offer) =>
          offer.status === "active" &&
          (!offer.expires_at || Date.parse(offer.expires_at) > Date.now()),
      ),
    [offers],
  );
  const offersById = useMemo(
    () => new Map(offers.map((offer) => [offer.offer_id, offer])),
    [offers],
  );

  useEffect(() => {
    setOfferId((current) =>
      current && eligibleOffers.some((offer) => offer.offer_id === current)
        ? current
        : (eligibleOffers[0]?.offer_id ?? ""),
    );
  }, [eligibleOffers]);

  useEffect(() => {
    if (oneTimePath) copyButtonRef.current?.focus();
  }, [oneTimePath]);

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submittingRef.current || oneTimePath) return;

    const normalizedChannelKey = channelKey.trim();
    const normalizedSourceRef = sourceRef.trim();
    const normalizedCampaignRef = campaignRef.trim();
    const validationError = validateCreateInput(
      {
        offerId,
        channelKey: normalizedChannelKey,
        sourceRef: normalizedSourceRef,
        campaignRef: normalizedCampaignRef,
        expiresAt,
      },
      locale,
    );
    if (validationError) {
      setFormError(validationError);
      return;
    }

    const normalizedExpiry = expiresAt
      ? new Date(expiresAt).toISOString()
      : null;
    submittingRef.current = true;
    setSubmitting(true);
    setFormError(null);
    try {
      const created = await createStoreAcquisitionLink({
        storeId: store.id,
        offerId,
        channelKey: normalizedChannelKey,
        sourceRef: normalizedSourceRef || null,
        campaignRef: normalizedCampaignRef || null,
        expiresAt: normalizedExpiry,
      });
      setLinks((current) => [
        created.link,
        ...(current ?? []).filter((link) => link.id !== created.link.id),
      ]);
      setChannelKey("");
      setSourceRef("");
      setCampaignRef("");
      setExpiresAt("");
      setCopyState("idle");
      setOneTimePath(created.shortPath);
      setAnnouncement(
        english
          ? "Channel link created. Copy the one-time path before closing it."
          : "渠道链接已创建，请在关闭前复制一次性路径。",
      );
    } catch (cause) {
      setFormError(
        errorMessage(
          cause,
          locale,
          "The channel link could not be created.",
          "渠道链接创建失败，请重试。",
        ),
      );
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const toggleLink = async (link: StoreAcquisitionLink) => {
    if (updatingRef.current.has(link.id)) return;
    const configured = configuredStatus(link);
    const nextStatus: StoreAcquisitionLinkConfiguredStatus =
      configured === "active" ? "disabled" : "active";
    if (nextStatus === "active" && effectiveStatus(link) === "expired") {
      setActionErrors((current) => ({
        ...current,
        [link.id]: {
          conflict: false,
          message: english
            ? "Expired links cannot be re-enabled. Create a new link instead."
            : "已过期的链接不能重新启用，请创建新链接。",
        },
      }));
      return;
    }

    updatingRef.current.add(link.id);
    setUpdatingIds(new Set(updatingRef.current));
    setActionErrors((current) => withoutKey(current, link.id));
    try {
      const updated = await updateStoreAcquisitionLinkStatus({
        storeId: store.id,
        linkId: link.id,
        status: nextStatus,
        expectedVersion: link.version,
      });
      setLinks((current) =>
        current?.map((item) => (item.id === updated.id ? updated : item)) ??
        current,
      );
      setAnnouncement(
        english
          ? `Channel ${updated.channelKey} is now ${nextStatus}.`
          : `渠道 ${updated.channelKey} 已${nextStatus === "active" ? "启用" : "停用"}。`,
      );
    } catch (cause) {
      const conflict =
        cause instanceof MarketplaceApiError && cause.status === 409;
      setActionErrors((current) => ({
        ...current,
        [link.id]: {
          conflict,
          message: conflict
            ? english
              ? "This link changed elsewhere. Refresh before trying again."
              : "这条链接已在其他页面更新，请刷新后重试。"
            : errorMessage(
                cause,
                locale,
                "The link status could not be saved.",
                "链接状态保存失败，请重试。",
              ),
        },
      }));
    } finally {
      updatingRef.current.delete(link.id);
      setUpdatingIds(new Set(updatingRef.current));
    }
  };

  const copyPath = async () => {
    if (!oneTimePath) return;
    setCopyState("idle");
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(oneTimePath);
      setCopyState("copied");
      setAnnouncement(
        english ? "Channel path copied." : "渠道路径已复制。",
      );
    } catch {
      setCopyState("error");
      setAnnouncement(
        english
          ? "Copy failed. The path remains visible for manual copying."
          : "复制失败，路径仍可见，可手动复制。",
      );
    }
  };

  const closeOneTimePath = () => {
    setOneTimePath(null);
    setCopyState("idle");
    setAnnouncement(
      english
        ? "The one-time path was closed and cannot be shown again."
        : "一次性路径已关闭，之后无法再次查看。",
    );
    requestAnimationFrame(() => createButtonRef.current?.focus());
  };

  const initiallyLoading = links === null && refreshing;
  const showInitialError = links === null && Boolean(loadError);

  return (
    <section className={styles.panel} aria-labelledby="acquisition-links-title">
      <header className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>
            {english ? "ATTRIBUTION" : "渠道归因"}
          </p>
          <h2 id="acquisition-links-title">
            {english ? "Channel links" : "渠道链接"}
          </h2>
          <p className={styles.description}>
            {english
              ? "Create bounded paths for a store product. Only landing attribution is recorded; no CRM identity is inferred."
              : "为本店商品创建有边界的访问路径。仅记录落地归因，不推测 CRM 或跨平台身份。"}
          </p>
        </div>
        <Button
          variant="outline"
          size="md"
          className={styles.refreshButton}
          type="button"
          disabled={refreshing}
          aria-busy={refreshing}
          onClick={() => void load()}
        >
          <RefreshCw
            size={16}
            aria-hidden="true"
            className={refreshing ? styles.spinning : undefined}
          />
          {refreshing
            ? english
              ? "Refreshing…"
              : "刷新中…"
            : english
              ? "Refresh"
              : "刷新"}
        </Button>
      </header>

      <p
        className={styles.visuallyHidden}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </p>

      {oneTimePath ? (
        <section
          className={styles.oneTimeResult}
          aria-labelledby="acquisition-one-time-title"
        >
          <div className={styles.oneTimeHeading}>
            <div>
              <p className={styles.eyebrow}>
                {english ? "ONE-TIME RESULT" : "一次性结果"}
              </p>
              <h3 id="acquisition-one-time-title">
                {english ? "Copy this channel path now" : "请立即复制渠道路径"}
              </h3>
            </div>
            <button
              className={styles.iconButton}
              type="button"
              aria-label={english ? "Close one-time path" : "关闭一次性路径"}
              onClick={closeOneTimePath}
            >
              <X size={17} aria-hidden="true" />
            </button>
          </div>
          <p className={styles.warning}>
            {english
              ? "After you close this result, the full /r/<token> path cannot be viewed again."
              : "关闭后无法再次查看完整的 /r/<token> 路径。"}
          </p>
          <code className={styles.secretPath} tabIndex={0}>
            {oneTimePath}
          </code>
          <div className={styles.oneTimeActions}>
            <Button
              ref={copyButtonRef}
              variant="primary"
              size="md"
              type="button"
              onClick={() => void copyPath()}
            >
              {copyState === "copied" ? (
                <Check size={16} aria-hidden="true" />
              ) : (
                <Copy size={16} aria-hidden="true" />
              )}
              {copyState === "copied"
                ? english
                  ? "Copied"
                  : "已复制"
                : copyState === "error"
                  ? english
                    ? "Try copy again"
                    : "重新复制"
                  : english
                    ? "Copy path"
                    : "复制路径"}
            </Button>
            <Button
              variant="outline"
              size="md"
              type="button"
              onClick={closeOneTimePath}
            >
              {english ? "Close permanently" : "关闭且不再显示"}
            </Button>
          </div>
          {copyState === "error" ? (
            <p className={styles.copyFeedback} role="status">
              {english
                ? "Clipboard access failed. Select the visible path to copy it manually, or try again."
                : "浏览器未授予剪贴板权限。可选中上方路径手动复制，或再次尝试。"}
            </p>
          ) : null}
        </section>
      ) : null}

      <form className={styles.createForm} onSubmit={(event) => void submit(event)}>
        <div className={styles.sectionHeading}>
          <div>
            <h3>{english ? "Create a link" : "创建链接"}</h3>
            <p>
              {english
                ? "The token is returned only after a successful create."
                : "只有创建成功后才会返回一次完整 token。"}
            </p>
          </div>
        </div>

        <div className={styles.formGrid}>
          <label className={styles.fullField}>
            <span>{english ? "Store product" : "关联商品"}</span>
            <select
              aria-label={english ? "Store product" : "关联商品"}
              value={offerId}
              required
              disabled={submitting || eligibleOffers.length === 0}
              onChange={(event) => {
                setOfferId(event.target.value);
                setFormError(null);
              }}
            >
              {eligibleOffers.length === 0 ? (
                <option value="">
                  {english ? "No eligible products" : "暂无可选商品"}
                </option>
              ) : null}
              {eligibleOffers.map((offer) => (
                <option key={offer.offer_id} value={offer.offer_id}>
                  {offer.display_name} · {offer.status}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.fullField}>
            <span>{english ? "Canonical channel key" : "规范渠道键"}</span>
            <input
              aria-label={
                english ? "Canonical channel key" : "规范渠道键"
              }
              value={channelKey}
              required
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              placeholder="partner.referral"
              aria-describedby="acquisition-channel-help"
              onChange={(event) => {
                setChannelKey(event.target.value);
                setFormError(null);
              }}
            />
            <small id="acquisition-channel-help">
              {english
                ? "1–64 lowercase characters; start with a letter, then a–z, 0–9, dot, underscore, or hyphen."
                : "1–64 位小写规范键：字母开头，可含数字、点、下划线或连字符。"}
            </small>
          </label>
          <label>
            <span>{english ? "Source reference (optional)" : "来源引用（可选）"}</span>
            <input
              aria-label={
                english ? "Source reference (optional)" : "来源引用（可选）"
              }
              value={sourceRef}
              maxLength={MAX_REFERENCE_LENGTH}
              autoComplete="off"
              placeholder={english ? "publisher-7" : "publisher-7"}
              onChange={(event) => {
                setSourceRef(event.target.value);
                setFormError(null);
              }}
            />
          </label>
          <label>
            <span>{english ? "Campaign reference (optional)" : "活动引用（可选）"}</span>
            <input
              aria-label={
                english ? "Campaign reference (optional)" : "活动引用（可选）"
              }
              value={campaignRef}
              maxLength={MAX_REFERENCE_LENGTH}
              autoComplete="off"
              placeholder={english ? "launch-2026" : "launch-2026"}
              onChange={(event) => {
                setCampaignRef(event.target.value);
                setFormError(null);
              }}
            />
          </label>
          <label className={styles.fullField}>
            <span>{english ? "Expiry (optional)" : "到期时间（可选）"}</span>
            <input
              aria-label={english ? "Expiry (optional)" : "到期时间（可选）"}
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => {
                setExpiresAt(event.target.value);
                setFormError(null);
              }}
            />
            <small>
              {english
                ? "Must be a future time in your current time zone."
                : "必须是当前时区中的未来时间。"}
            </small>
          </label>
        </div>

        {formError ? (
          <div className={styles.formError} role="alert">
            <AlertCircle size={16} aria-hidden="true" />
            <span>{formError}</span>
          </div>
        ) : null}

        <div className={styles.formActions}>
          <span>
            {eligibleOffers.length === 0
              ? english
                ? "Create an active or draft product first."
                : "请先创建可用的上架商品或草稿。"
              : english
                ? "References are limited to 128 characters each."
                : "来源与活动引用各不超过 128 个字符。"}
          </span>
          <Button
            ref={createButtonRef}
            variant="primary"
            size="md"
            type="submit"
            disabled={
              submitting ||
              Boolean(oneTimePath) ||
              eligibleOffers.length === 0 ||
              links === null
            }
            aria-busy={submitting}
          >
            <Link2 size={16} aria-hidden="true" />
            {submitting
              ? english
                ? "Creating…"
                : "创建中…"
              : english
                ? "Create channel link"
                : "创建渠道链接"}
          </Button>
        </div>
      </form>

      <section className={styles.listSection} aria-labelledby="channel-link-list-title">
        <div className={styles.sectionHeading}>
          <div>
            <h3 id="channel-link-list-title">
              {english ? "Existing links" : "现有链接"}
            </h3>
            <p>
              {english
                ? "Lists metadata only. Full tokens are never returned here."
                : "这里只列出元数据，不会再次返回完整 token。"}
            </p>
          </div>
          {links ? (
            <span className={styles.count}>{links.length}</span>
          ) : null}
        </div>

        {initiallyLoading ? (
          <div className={styles.state} role="status">
            {english ? "Loading channel links…" : "正在加载渠道链接…"}
          </div>
        ) : showInitialError ? (
          <div className={`${styles.state} ${styles.errorState}`} role="alert">
            <div>
              <strong>{english ? "Links unavailable" : "渠道链接加载失败"}</strong>
              <p>{loadError}</p>
            </div>
            <Button
              variant="outline"
              size="md"
              type="button"
              disabled={refreshing}
              onClick={() => void load()}
            >
              {english ? "Retry" : "重试"}
            </Button>
          </div>
        ) : links?.length === 0 ? (
          <div className={styles.state}>
            <Link2 size={20} aria-hidden="true" />
            <div>
              <strong>{english ? "No channel links yet" : "还没有渠道链接"}</strong>
              <p>
                {english
                  ? "Create one above when you have a bounded attribution use case."
                  : "需要进行有边界的渠道归因时，可在上方创建。"}
              </p>
            </div>
          </div>
        ) : links ? (
          <ul className={styles.linkList}>
            {links.map((link) => {
              const offer = offersById.get(link.offerId);
              const configured = configuredStatus(link);
              const effective = effectiveStatus(link);
              const updating = updatingIds.has(link.id);
              const actionError = actionErrors[link.id];
              const cannotEnable =
                configured === "disabled" && effective === "expired";
              return (
                <li key={link.id} className={styles.linkCard}>
                  <article aria-labelledby={`channel-link-${link.id}`}>
                    <div className={styles.cardHeading}>
                      <div>
                        <p>{english ? "CHANNEL" : "渠道"}</p>
                        <h4 id={`channel-link-${link.id}`}>{link.channelKey}</h4>
                        <span>
                          {offer?.display_name ??
                            (english ? "Product unavailable" : "商品不可用")}
                        </span>
                      </div>
                      <button
                        className={styles.switch}
                        type="button"
                        role="switch"
                        aria-checked={configured === "active"}
                        aria-label={
                          cannotEnable
                            ? english
                              ? `Expired link ${link.channelKey} cannot be re-enabled`
                              : `已过期链接 ${link.channelKey} 不能重新启用`
                            : configured === "active"
                              ? english
                                ? `Disable link ${link.channelKey}`
                                : `停用链接 ${link.channelKey}`
                              : english
                                ? `Enable link ${link.channelKey}`
                                : `启用链接 ${link.channelKey}`
                        }
                        disabled={
                          updating || cannotEnable || Boolean(actionError?.conflict)
                        }
                        aria-busy={updating}
                        onClick={() => void toggleLink(link)}
                      >
                        <span aria-hidden="true" />
                      </button>
                    </div>

                    <dl className={styles.metadata}>
                      <div>
                        <dt>{english ? "Product" : "关联商品"}</dt>
                        <dd>
                          <strong>
                            {offer?.display_name ??
                              (english ? "Unavailable" : "不可用")}
                          </strong>
                          <small>{offer?.external_key ?? link.offerId}</small>
                        </dd>
                      </div>
                      <div>
                        <dt>{english ? "References" : "渠道引用"}</dt>
                        <dd>
                          <span>
                            {english ? "Source" : "来源"}: {link.sourceRef ?? "—"}
                          </span>
                          <small>
                            {english ? "Campaign" : "活动"}: {link.campaignRef ?? "—"}
                          </small>
                        </dd>
                      </div>
                      <div>
                        <dt>{english ? "Configured" : "配置状态"}</dt>
                        <dd>{statusLabel(configured, locale)}</dd>
                      </div>
                      <div>
                        <dt>{english ? "Effective" : "生效状态"}</dt>
                        <dd>{statusLabel(effective, locale)}</dd>
                      </div>
                      <div>
                        <dt>{english ? "Expires" : "到期时间"}</dt>
                        <dd>{formatDate(link.expiresAt, locale)}</dd>
                      </div>
                      <div>
                        <dt>{english ? "Created" : "创建时间"}</dt>
                        <dd>{formatDate(link.createdAt, locale)}</dd>
                      </div>
                    </dl>

                    <div className={styles.statusAction}>
                      <span>
                        {updating
                          ? english
                            ? "Saving status…"
                            : "正在保存状态…"
                          : cannotEnable
                            ? english
                              ? "Expired links stay off. Create a new link to continue."
                              : "已过期链接保持关闭，如需继续请创建新链接。"
                            : configured === "active"
                              ? english
                                ? "Configured active"
                                : "当前配置为启用"
                              : english
                                ? "Configured disabled"
                                : "当前配置为停用"}
                      </span>
                    </div>

                    {actionError ? (
                      <div className={styles.actionError} role="alert">
                        <span>{actionError.message}</span>
                        {actionError.conflict ? (
                          <button type="button" onClick={() => void load()}>
                            {english ? "Refresh links" : "刷新链接"}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </article>
                </li>
              );
            })}
          </ul>
        ) : null}

        {links !== null && loadError ? (
          <div className={styles.inlineError} role="alert">
            <AlertCircle size={16} aria-hidden="true" />
            <span>{loadError}</span>
            <button type="button" onClick={() => void load()}>
              {english ? "Retry refresh" : "重试刷新"}
            </button>
          </div>
        ) : null}
      </section>
    </section>
  );
}

function validateCreateInput(
  input: {
    offerId: string;
    channelKey: string;
    sourceRef: string;
    campaignRef: string;
    expiresAt: string;
  },
  locale: InterfaceLocale,
): string | null {
  const english = locale === "en";
  if (!input.offerId) {
    return english ? "Choose a store product." : "请选择本店商品。";
  }
  if (!CHANNEL_KEY_PATTERN.test(input.channelKey)) {
    return english
      ? "Enter a canonical 1–64 character lowercase channel key."
      : "请输入 1–64 位小写规范渠道键。";
  }
  for (const reference of [input.sourceRef, input.campaignRef]) {
    if (
      (reference && [...reference].length > MAX_REFERENCE_LENGTH) ||
      CONTROL_CHARACTER_PATTERN.test(reference)
    ) {
      return english
        ? "Source and campaign references must be at most 128 safe characters."
        : "来源与活动引用必须是不超过 128 个字符的安全文本。";
    }
  }
  if (input.expiresAt) {
    const timestamp = new Date(input.expiresAt).getTime();
    if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
      return english
        ? "Choose an expiry time in the future."
        : "请选择未来的到期时间。";
    }
  }
  return null;
}

function configuredStatus(
  link: StoreAcquisitionLink,
): StoreAcquisitionLinkConfiguredStatus {
  return link.status === "disabled" ? "disabled" : "active";
}

function effectiveStatus(
  link: StoreAcquisitionLink,
): StoreAcquisitionLink["status"] {
  if (link.status === "expired" || hasExpired(link.expiresAt)) return "expired";
  return configuredStatus(link);
}

function hasExpired(value: string | null): boolean {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

function statusLabel(
  status: StoreAcquisitionLink["status"],
  locale: InterfaceLocale,
): string {
  if (locale === "en") {
    if (status === "active") return "Active";
    if (status === "disabled") return "Disabled";
    return "Expired";
  }
  if (status === "active") return "启用";
  if (status === "disabled") return "停用";
  return "已过期";
}

function formatDate(value: string | null, locale: InterfaceLocale): string {
  if (!value) return locale === "en" ? "Never" : "永不过期";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return locale === "en" ? "Unknown" : "未知";
  return new Intl.DateTimeFormat(locale === "en" ? "en" : "zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function errorMessage(
  cause: unknown,
  locale: InterfaceLocale,
  englishFallback: string,
  chineseFallback: string,
): string {
  if (locale !== "en" && cause instanceof Error && cause.message.trim()) {
    return cause.message;
  }
  return locale === "en" ? englishFallback : chineseFallback;
}

function withoutKey<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Readonly<Record<string, T>> {
  const next = { ...record };
  delete next[key];
  return next;
}

import {
  CheckCircle2,
  LoaderCircle,
  Mail,
  Phone,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";

import {
  getVerifiedContactChannels,
  MarketplaceApiError,
  type MallAssistantContactConsentAction,
  type MarketplaceContactResponse,
  type VerifiedContactChannel,
} from "../api";
import type { InterfaceLocale } from "../lib/preferences";

function contactChannelLabel(key: string, english: boolean): string {
  if (key === "email") return english ? "Email" : "邮箱";
  if (key === "phone") return english ? "Phone" : "手机";
  return key;
}

function currentLocation(): { pathname: string; search: string } {
  return typeof window === "undefined"
    ? { pathname: "/", search: "" }
    : { pathname: window.location.pathname, search: window.location.search };
}

export function StoreContactConsentCard({
  action,
  locale,
  onAgree,
  onRetrieve,
}: {
  action: MallAssistantContactConsentAction;
  locale: InterfaceLocale;
  onAgree?: (action: MallAssistantContactConsentAction) => Promise<unknown>;
  onRetrieve?: (
    action: MallAssistantContactConsentAction,
  ) => Promise<MarketplaceContactResponse | null>;
}) {
  const english = locale === "en";
  const [channels, setChannels] = useState<VerifiedContactChannel[]>([]);
  const [status, setStatus] = useState<
    | "loading"
    | "ready"
    | "agreeing"
    | "accepted"
    | "checking"
    | "released"
    | "declined"
    | "failed"
  >("loading");
  const [error, setError] = useState<string | null>(null);
  const [contact, setContact] = useState<MarketplaceContactResponse | null>(
    null,
  );
  const [checkMessage, setCheckMessage] = useState<string | null>(null);
  const [signInRequired, setSignInRequired] = useState(false);

  const load = async () => {
    setStatus("loading");
    setError(null);
    setSignInRequired(false);
    try {
      setChannels(await getVerifiedContactChannels());
      setStatus("ready");
    } catch (cause) {
      if (cause instanceof MarketplaceApiError && cause.status === 401) {
        setSignInRequired(true);
      }
      setError(
        cause instanceof Error
          ? cause.message
          : english
            ? "Unable to load verified contact details."
            : "无法读取已验证联系方式。",
      );
      setStatus("failed");
    }
  };

  useEffect(() => {
    void load();
  }, [action.id]);

  if (
    status === "accepted" ||
    status === "checking" ||
    status === "released" ||
    status === "declined"
  ) {
    const accepted = status !== "declined";
    return (
      <div
        className={`store-contact-consent-result is-${status}`}
        role="status"
      >
        {accepted ? (
          <CheckCircle2 size={18} aria-hidden="true" />
        ) : (
          <X size={18} aria-hidden="true" />
        )}
        <div>
          <strong>
            {accepted
              ? status === "released"
                ? english
                  ? "Verified store contact unlocked"
                  : "已解锁店员的已验证联系方式"
                : english
                  ? "Contact request sent"
                  : "联系申请已发送"
              : english
                ? "Contact exchange declined"
                : "已拒绝交换联系方式"}
          </strong>
          <span>
            {accepted
              ? english
                ? "Details are released only after store staff also approve. Nothing is shared automatically."
                : "只有店员也同意后才会交换；平台不会自动展示或发送联系方式。"
              : english
                ? "No contact details were shared. The AI manager remains available."
                : "没有交换任何联系方式，AI 店长仍会继续对话。"}
          </span>
          {contact ? (
            <dl className="store-contact-released-values">
              {Object.entries(contact.counterpart.contact).map(
                ([key, value]) => (
                  <div key={key}>
                    <dt>{contactChannelLabel(key, english)}</dt>
                    <dd>{value}</dd>
                  </div>
                ),
              )}
            </dl>
          ) : accepted && onRetrieve ? (
            <button
              className="button button-muted store-contact-check"
              type="button"
              disabled={status === "checking"}
              onClick={async () => {
                setStatus("checking");
                setCheckMessage(null);
                try {
                  const result = await onRetrieve(action);
                  if (result) {
                    setContact(result);
                    setStatus("released");
                    return;
                  }
                  setCheckMessage(
                    english
                      ? "Store staff have not approved yet. Check notifications and try again later."
                      : "店员尚未同意。请留意通知，稍后再检查。",
                  );
                  setStatus("accepted");
                } catch (cause) {
                  setCheckMessage(
                    cause instanceof Error
                      ? cause.message
                      : english
                        ? "Unable to check contact status."
                        : "暂时无法检查联系状态。",
                  );
                  setStatus("accepted");
                }
              }}
            >
              {status === "checking"
                ? english
                  ? "Checking…"
                  : "检查中…"
                : english
                  ? "Check store approval"
                  : "检查店员是否同意"}
            </button>
          ) : null}
          {checkMessage ? (
            <span className="store-contact-check-message">{checkMessage}</span>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <section
      className="store-contact-consent"
      aria-labelledby={`${action.id}-title`}
    >
      <div className="store-contact-consent-heading">
        <ShieldCheck size={19} aria-hidden="true" />
        <div>
          <strong id={`${action.id}-title`}>
            {english ? "Confirm contact exchange" : "确认交换联系方式"}
          </strong>
          <span>{action.reason}</span>
        </div>
      </div>

      {status === "loading" ? (
        <div className="store-contact-consent-loading" role="status">
          <LoaderCircle className="is-spinning" size={17} aria-hidden="true" />
          {english ? "Loading verified bindings…" : "正在读取已验证绑定…"}
        </div>
      ) : status === "failed" ? (
        <div className="store-contact-consent-error" role="alert">
          <span>{error}</span>
          {signInRequired ? (
            <a
              href={(() => {
                const { pathname, search } = currentLocation();
                return `/login?next=${encodeURIComponent(`${pathname}${search}`)}`;
              })()}
            >
              {english ? "Sign in" : "前往登录"}
            </a>
          ) : (
            <button type="button" onClick={() => void load()}>
              {english ? "Retry" : "重试"}
            </button>
          )}
        </div>
      ) : channels.length ? (
        <>
          <p className="store-contact-consent-explain">
            {english
              ? "If you agree, only the verified bindings below can be released after store staff also approve. The AI cannot edit these values or consent for you."
              : "同意后，只有以下已验证绑定可在店员也同意后交换。AI 不能修改这些内容，也不能替你同意。"}
          </p>
          <ul className="store-contact-consent-channels">
            {channels.map((channel) => (
              <li key={`${channel.type}:${channel.value}`}>
                {channel.type === "email" ? (
                  <Mail size={16} aria-hidden="true" />
                ) : (
                  <Phone size={16} aria-hidden="true" />
                )}
                <span>
                  <small>
                    {channel.type === "email"
                      ? english
                        ? "Verified email"
                        : "已验证邮箱"
                      : english
                        ? "Verified phone"
                        : "已验证手机"}
                  </small>
                  <strong>{channel.value}</strong>
                </span>
              </li>
            ))}
          </ul>
          <div className="store-contact-consent-actions">
            <button
              className="button button-dark"
              type="button"
              disabled={status === "agreeing" || !onAgree}
              onClick={async () => {
                if (!onAgree) return;
                setStatus("agreeing");
                setError(null);
                try {
                  await onAgree(action);
                  setStatus("accepted");
                } catch (cause) {
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : english
                        ? "Contact request failed."
                        : "联系申请发送失败。",
                  );
                  setStatus("failed");
                }
              }}
            >
              {status === "agreeing"
                ? english
                  ? "Sending…"
                  : "发送中…"
                : english
                  ? "Agree and request contact"
                  : "同意并申请联系"}
            </button>
            <button
              className="button button-muted"
              type="button"
              disabled={status === "agreeing"}
              onClick={() => setStatus("declined")}
            >
              {english ? "Decline" : "拒绝"}
            </button>
          </div>
        </>
      ) : (
        <div className="store-contact-consent-empty">
          <strong>
            {english ? "No verified email or phone" : "没有已验证的邮箱或手机"}
          </strong>
          <span>
            {english
              ? "Bind and verify a contact method in Account before agreeing. Manual entry is not supported."
              : "请先在账号中绑定并验证联系方式；平台不支持手填。"}
          </span>
          <div className="store-contact-consent-empty-actions">
            <a
              href={`${currentLocation().pathname}?account=identity`}
              onClick={(event) => {
                // The app shell opens the account dialog in place (and cancels this
                // event) so the ongoing store chat is not lost to a full navigation.
                const handledInApp = !window.dispatchEvent(
                  new CustomEvent("matchplane.account.bindings", {
                    cancelable: true,
                  }),
                );
                if (handledInApp) event.preventDefault();
              }}
            >
              {english ? "Open account bindings" : "前往账号绑定"}
            </a>
            <button type="button" onClick={() => void load()}>
              {english ? "I bound one — check again" : "我已完成绑定，重新检测"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

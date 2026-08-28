"use client";

import { buttonVariants } from "@appica/ui-react";
import { ArrowRight, Check, Copy, Link2, UserPlus } from "lucide-react";

import type { StoreCollaboratorInvite, StoreSummary } from "../api";
import type { InterfaceLocale } from "../lib/preferences";

interface OwnedStoreCardProps {
  store: StoreSummary;
  secondary: boolean;
  locale: InterfaceLocale;
  invite: StoreCollaboratorInvite | null;
  createdStoreId?: string;
  invitingStoreId: string | null;
  copied: boolean;
  onGenerateInvite: (storeId: string) => void;
  onCopyInvite: () => void;
  onManageStore?: (store: StoreSummary) => void;
}

export function OwnedStoreCard({
  store,
  secondary,
  locale,
  invite,
  createdStoreId,
  invitingStoreId,
  copied,
  onGenerateInvite,
  onCopyInvite,
  onManageStore,
}: OwnedStoreCardProps) {
  const english = locale === "en";
  const status = store.status ?? "pending";
  const canInvite =
    store.membershipRole === "owner" ||
    store.membershipRole === "mall_operator";
  const showsInvite =
    invite?.storeId === store.id && createdStoreId !== store.id;
  const inviteLabel =
    invitingStoreId === store.id
      ? english
        ? "Creating…"
        : "生成中…"
      : invite?.storeId === store.id
        ? english
          ? "Link ready"
          : "链接已生成"
        : english
          ? "Invite"
          : "邀请协作";
  const statusLabel = {
    active: english ? "Open" : "营业中",
    closed: english ? "Closed" : "已打烊",
    pending: english ? "Review" : "审核中",
    suspended: english ? "Suspended" : "已暂停",
  }[status];
  const inactiveDescription = {
    active: store.description || (english ? "Hosted store" : "托管店铺"),
    closed: english
      ? "Public sales are paused; products and collaborators remain available to manage."
      : "已暂停公开营业；商品与协作入口仍可管理。",
    pending: english
      ? "Store details are under review before public opening."
      : "店铺资料正在审核，通过后恢复公开营业。",
    suspended: english
      ? "Public access is suspended; open the workspace to review its status."
      : "店铺已暂停公开展示；可进入工作台查看状态。",
  }[status];
  const enterLabel =
    status === "active"
      ? english
        ? "Open store"
        : "进入店铺"
      : english
        ? "View status"
        : "查看状态";

  return (
    <li className={`owned-store-card${secondary ? " is-secondary" : ""}`}>
      <div className="owned-store-card-main">
        <div className="owned-store-card-copy">
          <div className="owned-store-card-title-row">
            <strong>{store.displayName}</strong>
            <span className={`store-status-badge is-${status}`}>
              {statusLabel}
            </span>
          </div>
          <p>
            {secondary
              ? inactiveDescription
              : store.description || (english ? "Hosted store" : "托管店铺")}
          </p>
        </div>
        <a
          href={store.path}
          data-slot="button"
          className={buttonVariants({
            variant: secondary ? "outline" : "primary",
            size: "md",
            className: "owned-store-enter min-h-11",
          })}
        >
          {enterLabel}
          <ArrowRight size={16} aria-hidden="true" />
        </a>
      </div>
      <div className="owned-store-card-toolbar">
        {canInvite ? (
          <button
            type="button"
            className="owned-store-secondary-action"
            onClick={() => {
              if (invite?.storeId !== store.id) onGenerateInvite(store.id);
            }}
            disabled={invitingStoreId !== null || invite?.storeId === store.id}
            aria-disabled={invite?.storeId === store.id ? true : undefined}
          >
            <UserPlus size={15} aria-hidden="true" />
            {inviteLabel}
          </button>
        ) : null}
        {onManageStore ? (
          <button
            className="owned-store-secondary-action"
            type="button"
            onClick={() => onManageStore(store)}
          >
            {english ? "Products" : "管理商品"}
          </button>
        ) : (
          <a
            className="owned-store-secondary-action"
            href={`${store.path}?console=products`}
          >
            {english ? "Products" : "管理商品"}
          </a>
        )}
      </div>
      {showsInvite && invite ? (
        <InviteLinkPanel
          invite={invite}
          locale={locale}
          copied={copied}
          regenerating={invitingStoreId === store.id}
          onCopy={onCopyInvite}
          onRegenerate={() => onGenerateInvite(store.id)}
        />
      ) : null}
    </li>
  );
}

export function InviteLinkPanel({
  invite,
  locale,
  copied,
  regenerating,
  onCopy,
  onRegenerate,
}: {
  invite: StoreCollaboratorInvite;
  locale: InterfaceLocale;
  copied: boolean;
  regenerating: boolean;
  onCopy: () => void;
  onRegenerate: () => void;
}) {
  const english = locale === "en";
  const expiresAt = new Intl.DateTimeFormat(english ? "en" : "zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(invite.expiresAt));

  return (
    <div className="hosted-store-invite" role="status">
      <div className="hosted-store-invite-heading">
        <Link2 size={18} aria-hidden="true" />
        <div>
          <strong>{english ? "Collaborator invite" : "店铺协作邀请"}</strong>
          <p>
            {english
              ? "One person can use each link within seven days. They can manage products, but not store ownership or members."
              : "每条链接限一人于 7 天内使用；对方可管理商品，不能转移店铺或管理成员。"}
          </p>
        </div>
      </div>
      <div className="hosted-store-invite-url">
        <input
          aria-label={english ? "Collaborator invite link" : "协作邀请链接"}
          value={invite.registrationUrl}
          readOnly
          onFocus={(event) => event.currentTarget.select()}
        />
        <button type="button" onClick={onCopy}>
          {copied ? (
            <Check size={16} aria-hidden="true" />
          ) : (
            <Copy size={16} aria-hidden="true" />
          )}
          {copied ? (english ? "Copied" : "已复制") : english ? "Copy" : "复制"}
        </button>
      </div>
      <div className="hosted-store-invite-meta">
        <span>{english ? `Expires ${expiresAt}` : `${expiresAt} 到期`}</span>
        <button type="button" onClick={onRegenerate} disabled={regenerating}>
          {regenerating
            ? english
              ? "Creating…"
              : "正在生成…"
            : english
              ? "Create another link"
              : "再生成一条"}
        </button>
      </div>
    </div>
  );
}

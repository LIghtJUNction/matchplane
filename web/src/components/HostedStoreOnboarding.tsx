import {
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  Link2,
  Plus,
  UserPlus,
} from "lucide-react";
import { type SyntheticEvent, useEffect, useState } from "react";

import {
  createHostedStore,
  createStoreCollaboratorInvite,
  getOwnedStores,
  type StoreCollaboratorInvite,
  type StoreSummary,
} from "../api";
import type { InterfaceLocale } from "../lib/preferences";

export function HostedStoreOnboarding({
  locale,
  onNotice,
  initialStores = [],
  onStoresChange,
  onManageStore,
}: {
  locale: InterfaceLocale;
  onNotice: (message: string) => void;
  initialStores?: StoreSummary[];
  onStoresChange?: (stores: StoreSummary[]) => void;
  onManageStore?: (store: StoreSummary) => void;
}) {
  const [stores, setStores] = useState<StoreSummary[]>(initialStores);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [opening, setOpening] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [createdStore, setCreatedStore] = useState<StoreSummary | null>(null);
  const [invite, setInvite] = useState<StoreCollaboratorInvite | null>(null);
  const [invitingStoreId, setInvitingStoreId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(false);
    getOwnedStores()
      .then((items) => {
        if (!active) return;
        setStores(items);
        onStoresChange?.(items);
      })
      .catch(() => {
        if (!active) return;
        setLoadError(true);
        onNotice(
          locale === "en" ? "Could not load your stores." : "店铺列表读取失败",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [locale, onNotice, reloadKey]);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const store = await createHostedStore({
        name: name.trim(),
        description: description.trim(),
      });
      const nextStores = [
        store,
        ...stores.filter((item) => item.id !== store.id),
      ];
      setStores(nextStores);
      onStoresChange?.(nextStores);
      setCreatedStore(store);
      setInvite(null);
      setCopied(false);
      setName("");
      setDescription("");
      setOpening(false);
      onNotice(locale === "en" ? "Store created." : "店铺已创建");
    } catch (error) {
      onNotice(
        error instanceof Error
          ? error.message
          : locale === "en"
            ? "Could not create the store."
            : "店铺创建失败",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function generateInvite(storeId: string) {
    setInvitingStoreId(storeId);
    setCopied(false);
    try {
      const created = await createStoreCollaboratorInvite(storeId);
      setInvite(created);
      onNotice(
        locale === "en" ? "Collaborator link created." : "协作邀请链接已生成",
      );
    } catch (error) {
      onNotice(
        error instanceof Error
          ? error.message
          : locale === "en"
            ? "Could not create the invite link."
            : "邀请链接创建失败",
      );
    } finally {
      setInvitingStoreId(null);
    }
  }

  async function copyInviteLink() {
    if (!invite) return;
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(invite.registrationUrl);
      setCopied(true);
      onNotice(locale === "en" ? "Invite link copied." : "邀请链接已复制");
    } catch {
      onNotice(
        locale === "en"
          ? "The link is shown below; select it to copy."
          : "链接已显示，可选中后复制",
      );
    }
  }

  const openForm = () => {
    setOpening(true);
    setCreatedStore(null);
    setInvite(null);
    setCopied(false);
  };

  const sectionLabel = locale === "en" ? "Your stores" : "你的店铺";

  return (
    <section className="hosted-store-onboarding" aria-label={sectionLabel}>
      {loading ? (
        <p className="hosted-store-status" role="status">
          {locale === "en" ? "Loading stores…" : "正在读取店铺…"}
        </p>
      ) : null}

      {loadError ? (
        <div className="hosted-store-load-error" role="alert">
          <p>
            {locale === "en"
              ? "Your stores could not be loaded."
              : "暂时无法读取店铺列表。"}
          </p>
          <button
            type="button"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            {locale === "en" ? "Try again" : "重试"}
          </button>
        </div>
      ) : null}

      {createdStore ? (
        <div className="hosted-store-success" role="status">
          <CheckCircle2 size={22} aria-hidden="true" />
          <div>
            <strong>
              {locale === "en" ? "Your store is ready" : "店铺已经准备好了"}
            </strong>
            <p>
              {locale === "en"
                ? `${createdStore.displayName} now has an automatically assigned address.`
                : `${createdStore.displayName} 的访问地址已自动安排，无需再配置。`}
            </p>
          </div>
          <div className="hosted-store-success-actions">
            {invite?.storeId === createdStore.id ? null : (
              <button
                type="button"
                onClick={() => void generateInvite(createdStore.id)}
                disabled={invitingStoreId !== null}
              >
                <UserPlus size={16} aria-hidden="true" />
                {invitingStoreId === createdStore.id
                  ? locale === "en"
                    ? "Creating…"
                    : "正在生成…"
                  : locale === "en"
                    ? "Invite a partner"
                    : "邀请伙伴协作"}
              </button>
            )}
            {onManageStore ? (
              <button
                className="button button-dark"
                type="button"
                onClick={() => onManageStore(createdStore)}
              >
                {locale === "en" ? "Add products" : "开始添加商品"}
                <ArrowRight size={17} aria-hidden="true" />
              </button>
            ) : (
              <a
                className="button button-dark"
                href={`${createdStore.path}?console=products`}
              >
                {locale === "en" ? "Add products" : "开始添加商品"}
                <ArrowRight size={17} aria-hidden="true" />
              </a>
            )}
          </div>
        </div>
      ) : null}

      {createdStore && invite?.storeId === createdStore.id ? (
        <InviteLinkPanel
          invite={invite}
          locale={locale}
          copied={copied}
          regenerating={invitingStoreId === createdStore.id}
          onCopy={() => void copyInviteLink()}
          onRegenerate={() => void generateInvite(createdStore.id)}
        />
      ) : null}

      {!loading && !loadError && stores.length > 0 ? (
        <ul className="owned-store-grid">
          {stores.map((store) => {
            const canInvite =
              store.membershipRole === "owner" ||
              store.membershipRole === "mall_operator";
            const showsInvite =
              invite?.storeId === store.id && createdStore?.id !== store.id;
            const inviteLabel =
              invitingStoreId === store.id
                ? locale === "en"
                  ? "Creating…"
                  : "生成中…"
                : invite?.storeId === store.id
                  ? locale === "en"
                    ? "Link ready"
                    : "链接已生成"
                  : locale === "en"
                    ? "Invite"
                    : "邀请协作";
            return (
              <li key={store.id} className="owned-store-card">
                <div className="owned-store-card-main">
                  <div className="owned-store-card-copy">
                    <strong>{store.displayName}</strong>
                    <p>
                      {store.description ||
                        (locale === "en" ? "Hosted store" : "托管店铺")}
                    </p>
                  </div>
                  <a className="owned-store-enter" href={store.path}>
                    {locale === "en" ? "Open store" : "进入店铺"}
                    <ArrowRight size={16} aria-hidden="true" />
                  </a>
                </div>
                <div className="owned-store-card-toolbar">
                  {canInvite ? (
                    <button
                      type="button"
                      className="owned-store-secondary-action"
                      onClick={() => {
                        if (invite?.storeId !== store.id)
                          void generateInvite(store.id);
                      }}
                      disabled={
                        invitingStoreId !== null || invite?.storeId === store.id
                      }
                      aria-disabled={
                        invite?.storeId === store.id ? true : undefined
                      }
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
                      {locale === "en" ? "Products" : "管理商品"}
                    </button>
                  ) : (
                    <a
                      className="owned-store-secondary-action"
                      href={`${store.path}?console=products`}
                    >
                      {locale === "en" ? "Products" : "管理商品"}
                    </a>
                  )}
                </div>
                {showsInvite ? (
                  <InviteLinkPanel
                    invite={invite}
                    locale={locale}
                    copied={copied}
                    regenerating={invitingStoreId === store.id}
                    onCopy={() => void copyInviteLink()}
                    onRegenerate={() => void generateInvite(store.id)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {!loading && !loadError && !opening ? (
        stores.length === 0 ? (
          <div className="hosted-store-empty-state">
            <p>
              {locale === "en"
                ? "A name and short introduction are enough to begin."
                : "填写名称和简介即可开店。"}
            </p>
            <button
              className="button button-dark hosted-store-empty-action"
              type="button"
              onClick={openForm}
            >
              <Plus size={16} aria-hidden="true" />
              {locale === "en" ? "Open a store" : "开一家店"}
            </button>
          </div>
        ) : (
          <div className="hosted-store-add-row">
            <button
              className="hosted-store-add"
              type="button"
              onClick={openForm}
            >
              <Plus size={16} aria-hidden="true" />
              {locale === "en" ? "Open another store" : "再开一家店"}
            </button>
          </div>
        )
      ) : null}

      {opening ? (
        <form className="hosted-store-form" onSubmit={submit}>
          <div className="hosted-store-form-heading">
            <strong>
              {locale === "en" ? "Store details" : "填写店铺资料"}
            </strong>
            <button type="button" onClick={() => setOpening(false)}>
              {locale === "en" ? "Cancel" : "取消"}
            </button>
          </div>
          <label htmlFor="hosted-store-name">
            <span>{locale === "en" ? "Store name" : "店铺名称"}</span>
            <input
              id="hosted-store-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={200}
              autoComplete="organization"
              required
            />
          </label>
          <label htmlFor="hosted-store-description">
            <span>
              {locale === "en"
                ? "Short introduction (optional)"
                : "店铺简介（选填）"}
            </span>
            <textarea
              id="hosted-store-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
              maxLength={2000}
              placeholder={
                locale === "en" ? "What do you sell?" : "简单介绍你出售的商品"
              }
            />
          </label>
          <p className="hosted-store-form-note">
            {locale === "en"
              ? "The public address is assigned automatically. You can update store details later."
              : "访问地址会自动生成；店铺资料之后仍可修改。"}
          </p>
          <button
            className="button button-dark"
            type="submit"
            disabled={submitting}
          >
            {submitting
              ? locale === "en"
                ? "Creating…"
                : "正在创建…"
              : locale === "en"
                ? "Create store"
                : "创建店铺"}
            <ArrowRight size={18} aria-hidden="true" />
          </button>
        </form>
      ) : null}
    </section>
  );
}

function InviteLinkPanel({
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
  const expiresAt = new Intl.DateTimeFormat(locale === "en" ? "en" : "zh-CN", {
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
          <strong>
            {locale === "en" ? "Collaborator invite" : "店铺协作邀请"}
          </strong>
          <p>
            {locale === "en"
              ? "One person can use each link within seven days. They can manage products, but not store ownership or members."
              : "每条链接限一人于 7 天内使用；对方可管理商品，不能转移店铺或管理成员。"}
          </p>
        </div>
      </div>
      <div className="hosted-store-invite-url">
        <input
          aria-label={
            locale === "en" ? "Collaborator invite link" : "协作邀请链接"
          }
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
          {copied
            ? locale === "en"
              ? "Copied"
              : "已复制"
            : locale === "en"
              ? "Copy"
              : "复制"}
        </button>
      </div>
      <div className="hosted-store-invite-meta">
        <span>
          {locale === "en" ? `Expires ${expiresAt}` : `${expiresAt} 到期`}
        </span>
        <button type="button" onClick={onRegenerate} disabled={regenerating}>
          {regenerating
            ? locale === "en"
              ? "Creating…"
              : "正在生成…"
            : locale === "en"
              ? "Create another link"
              : "再生成一条"}
        </button>
      </div>
    </div>
  );
}

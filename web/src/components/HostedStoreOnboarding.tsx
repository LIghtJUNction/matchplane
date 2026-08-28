import { Button, buttonVariants } from "@appica/ui-react/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appica/ui-react/collapsible";
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Plus,
  UserPlus,
} from "lucide-react";
import { type SyntheticEvent, useEffect, useState } from "react";

import {
  createHostedStore,
  createStoreCollaboratorInvite,
  getOwnedStores,
  MarketplaceApiError,
  type StoreCollaboratorInvite,
  type StoreSummary,
} from "../api";
import type { InterfaceLocale } from "../lib/preferences";
import { InviteLinkPanel, OwnedStoreCard } from "./OwnedStoreCard";

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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [opening, setOpening] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [createdStore, setCreatedStore] = useState<StoreSummary | null>(null);
  const [invite, setInvite] = useState<StoreCollaboratorInvite | null>(null);
  const [invitingStoreId, setInvitingStoreId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const activeStores = stores.filter((store) => store.status === "active");
  const inactiveStores = stores.filter((store) => store.status !== "active");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(null);
    getOwnedStores()
      .then((items) => {
        if (!active) return;
        setStores(items);
        onStoresChange?.(items);
      })
      .catch((error) => {
        if (!active) return;
        const sessionUnavailable =
          error instanceof MarketplaceApiError &&
          (error.status === 401 || error.status === 403);
        const message = sessionUnavailable
          ? locale === "en"
            ? "Refresh your sign-in, then try again."
            : "请刷新登录状态后重试。"
          : locale === "en"
            ? "Your store data is unchanged. Check the connection and try again."
            : "店铺数据没有变化，请检查网络后重试。";
        setLoadError(message);
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
          <CircleAlert size={19} aria-hidden="true" />
          <div>
            <strong>
              {locale === "en"
                ? "Store list did not load"
                : "店铺列表没有加载成功"}
            </strong>
            <p>{loadError}</p>
          </div>
          <Button
            variant="outline"
            size="md"
            className="min-h-11"
            type="button"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            {locale === "en" ? "Try again" : "重新加载"}
          </Button>
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
              <Button
                variant="outline"
                size="md"
                className="min-h-11"
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
              </Button>
            )}
            {onManageStore ? (
              <Button
                variant="primary"
                size="md"
                className="min-h-11"
                type="button"
                onClick={() => onManageStore(createdStore)}
              >
                {locale === "en" ? "Add products" : "开始添加商品"}
                <ArrowRight size={17} aria-hidden="true" />
              </Button>
            ) : (
              <a
                href={`${createdStore.path}?console=products`}
                data-slot="button"
                className={buttonVariants({
                  variant: "primary",
                  size: "md",
                  className: "min-h-11",
                })}
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
        <div className="owned-store-groups">
          {activeStores.length > 0 ? (
            <ul
              className="owned-store-grid"
              aria-label={locale === "en" ? "Active stores" : "营业中的店铺"}
            >
              {activeStores.map((store) => (
                <OwnedStoreCard
                  key={store.id}
                  store={store}
                  secondary={false}
                  locale={locale}
                  invite={invite}
                  createdStoreId={createdStore?.id}
                  invitingStoreId={invitingStoreId}
                  copied={copied}
                  onGenerateInvite={(storeId) => void generateInvite(storeId)}
                  onCopyInvite={() => void copyInviteLink()}
                  onManageStore={onManageStore}
                />
              ))}
            </ul>
          ) : null}
          {inactiveStores.length > 0 ? (
            <Collapsible
              className="owned-store-inactive-group"
              defaultOpen={activeStores.length === 0}
            >
              <CollapsibleTrigger className="owned-store-inactive-trigger">
                <span>
                  {locale === "en" ? "Other stores" : "其他状态的店铺"}
                  <small>{inactiveStores.length}</small>
                </span>
                <ChevronDown aria-hidden="true" />
              </CollapsibleTrigger>
              <CollapsibleContent className="owned-store-inactive-content">
                <ul
                  className="owned-store-grid"
                  aria-label={
                    locale === "en" ? "Inactive stores" : "非营业店铺"
                  }
                >
                  {inactiveStores.map((store) => (
                    <OwnedStoreCard
                      key={store.id}
                      store={store}
                      secondary
                      locale={locale}
                      invite={invite}
                      createdStoreId={createdStore?.id}
                      invitingStoreId={invitingStoreId}
                      copied={copied}
                      onGenerateInvite={(storeId) =>
                        void generateInvite(storeId)
                      }
                      onCopyInvite={() => void copyInviteLink()}
                      onManageStore={onManageStore}
                    />
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </div>
      ) : null}

      {!loading && !loadError && !opening ? (
        stores.length === 0 ? (
          <div className="hosted-store-empty-state">
            <p>
              {locale === "en"
                ? "A name and short introduction are enough to begin."
                : "填写名称和简介即可开店。"}
            </p>
            <Button
              variant="primary"
              size="md"
              className="min-h-11"
              type="button"
              onClick={openForm}
            >
              <Plus size={16} aria-hidden="true" />
              {locale === "en" ? "Open a store" : "开一家店"}
            </Button>
          </div>
        ) : (
          <div className="hosted-store-add-row">
            <Button
              variant="outline"
              size="md"
              className="min-h-11"
              type="button"
              onClick={openForm}
            >
              <Plus size={16} aria-hidden="true" />
              {locale === "en" ? "Open another store" : "再开一家店"}
            </Button>
          </div>
        )
      ) : null}

      {opening ? (
        <form className="hosted-store-form" onSubmit={submit}>
          <div className="hosted-store-form-heading">
            <strong>
              {locale === "en" ? "Store details" : "填写店铺资料"}
            </strong>
            <Button
              variant="ghost"
              size="md"
              className="min-h-11"
              type="button"
              onClick={() => setOpening(false)}
            >
              {locale === "en" ? "Cancel" : "取消"}
            </Button>
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
          <Button
            variant="primary"
            size="md"
            className="min-h-11"
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
          </Button>
        </form>
      ) : null}
    </section>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Globe2, MailPlus, Search, ShieldCheck, UserMinus, Users } from "lucide-react";

import {
  createPlatformApiKey,
  createPlatformAdminInvite,
  createPlatformOidcClient,
  activateFederationBinding,
  createFederationInvite,
  getFederationBindings,
  getPlatformDomains,
  getPlatformAccounts,
  getPlatformApiKeys,
  getPlatformMembers,
  getPlatformOidcClients,
  invitePlatformMember,
  removePlatformMember,
  revokePlatformApiKey,
  revokeFederationBinding,
  probeFederationBinding,
  updatePlatformMember,
  updatePlatformApiKey,
  updatePlatformOidcClient,
  type PlatformAccountRecord,
  type PlatformAdminInvite,
  type PlatformApiKeyRecord,
  type PlatformOidcClientRecord,
  type PlatformMemberDirectory,
  type PlatformMemberRecord,
  type FederationBindingRecord,
  type SubplatformOrganizationRecord,
} from "../api";

interface PlatformAccessPanelProps {
  organizations: SubplatformOrganizationRecord[];
  rootRole?: string | null;
  onNotice: (message: string) => void;
}

/**
 * Organization access is deliberately a small, data-backed control surface. It never creates a
 * second login table: Better Auth owns the account, invitation, membership and role state.
 */
export function PlatformAccessPanel({ organizations, rootRole, onNotice }: PlatformAccessPanelProps) {
  const isMallOperator = rootRole === "rootSuperAdmin" || rootRole === "rootAdmin";
  const [organizationId, setOrganizationId] = useState("");
  const [directory, setDirectory] = useState<PlatformMemberDirectory | null>(null);
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("admin");
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<PlatformAccountRecord[]>([]);
  const [administratorLoading, setAdministratorLoading] = useState(false);
  const [accountSearch, setAccountSearch] = useState("");
  const [accessView, setAccessView] = useState<"accounts" | "team">(isMallOperator ? "accounts" : "team");
  const [administratorInviteEmail, setAdministratorInviteEmail] = useState("");
  const [newAdministratorInvite, setNewAdministratorInvite] = useState<PlatformAdminInvite | null>(null);
  const [apiKeys, setApiKeys] = useState<PlatformApiKeyRecord[]>([]);
  const [apiKeyLoading, setApiKeyLoading] = useState(false);
  const [apiKeyName, setApiKeyName] = useState("");
  const [apiKeySide, setApiKeySide] = useState<"none" | "demand" | "supply" | "both">("none");
  const [newApiKeySecret, setNewApiKeySecret] = useState<string | null>(null);
  const [oidcClients, setOidcClients] = useState<PlatformOidcClientRecord[]>([]);
  const [oidcLoading, setOidcLoading] = useState(false);
  const [oidcRegistrationId, setOidcRegistrationId] = useState("");
  const [oidcName, setOidcName] = useState("");
  const [oidcRedirectUri, setOidcRedirectUri] = useState("");
  const [newOidcSecret, setNewOidcSecret] = useState<string | null>(null);
  const [federationBindings, setFederationBindings] = useState<FederationBindingRecord[]>([]);
  const [federationDomains, setFederationDomains] = useState<Array<{ id: string; slug: string; name: string }>>([]);
  const [federationDomainId, setFederationDomainId] = useState("");
  const [federationExpiresHours, setFederationExpiresHours] = useState("24");
  const [federationTokenEnv, setFederationTokenEnv] = useState<Record<string, string>>({});
  const [newFederationInvite, setNewFederationInvite] = useState<{ token: string; url: string; expiresAt: string } | null>(null);
  const [federationLoading, setFederationLoading] = useState(false);

  const selectedOrganization = useMemo(
    () => organizations.find((organization) => organization.id === organizationId) ?? null,
    [organizationId, organizations],
  );

  const filteredAccounts = useMemo(() => {
    const needle = accountSearch.trim().toLocaleLowerCase();
    const byRole = (account: PlatformAccountRecord) => account.role === "rootSuperAdmin" ? 0 : account.role === "rootAdmin" ? 1 : 2;
    return accounts
      .filter((account) => !needle || `${account.name} ${account.email}`.toLocaleLowerCase().includes(needle))
      .sort((left, right) => byRole(left) - byRole(right) || right.createdAt.localeCompare(left.createdAt));
  }, [accountSearch, accounts]);

  const ordinaryAccountCount = accounts.filter((account) => account.role === "user").length;
  const storeOnlyScope = organizations.length === 1 && organizations[0]?.isRoot !== true;

  useEffect(() => {
    if (!organizationId && organizations[0]) setOrganizationId(organizations[0].id);
    if (organizationId && !organizations.some((organization) => organization.id === organizationId)) {
      setOrganizationId(organizations[0]?.id ?? "");
    }
  }, [organizationId, organizations]);

  useEffect(() => {
    if (!isMallOperator) setAccessView("team");
  }, [isMallOperator]);

  useEffect(() => {
    if (!organizationId) {
      setDirectory(null);
      return;
    }
    let mounted = true;
    setLoading(true);
    void getPlatformMembers(organizationId)
      .then((next) => { if (mounted) setDirectory(next); })
      .catch((error) => { if (mounted) onNotice(error instanceof Error ? error.message : "成员列表读取失败"); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [onNotice, organizationId]);

  useEffect(() => {
    if (rootRole !== "rootSuperAdmin" && rootRole !== "rootAdmin") return;
    let mounted = true;
    setOidcLoading(true);
    void getPlatformOidcClients()
      .then((next) => { if (mounted) setOidcClients(next); })
      .catch((error) => { if (mounted) onNotice(error instanceof Error ? error.message : "OIDC 客户端列表读取失败"); })
      .finally(() => { if (mounted) setOidcLoading(false); });
    return () => { mounted = false; };
  }, [onNotice, rootRole]);

  useEffect(() => {
    if (rootRole !== "rootSuperAdmin" && rootRole !== "rootAdmin") return;
    let mounted = true;
    setFederationLoading(true);
    void Promise.all([getFederationBindings(), getPlatformDomains()])
      .then(([bindings, domains]) => {
        if (!mounted) return;
        setFederationBindings(bindings);
        setFederationDomains(domains);
        setFederationDomainId((current) => current || domains[0]?.id || "");
      })
      .catch((error) => { if (mounted) onNotice(error instanceof Error ? error.message : "联邦节点列表读取失败"); })
      .finally(() => { if (mounted) setFederationLoading(false); });
    return () => { mounted = false; };
  }, [onNotice, rootRole]);

  useEffect(() => {
    if (!organizationId) {
      setApiKeys([]);
      return;
    }
    let mounted = true;
    setApiKeyLoading(true);
    void getPlatformApiKeys(organizationId)
      .then((next) => { if (mounted) setApiKeys(next); })
      .catch((error) => { if (mounted) onNotice(error instanceof Error ? error.message : "API Key 列表读取失败"); })
      .finally(() => { if (mounted) setApiKeyLoading(false); });
    return () => { mounted = false; };
  }, [onNotice, organizationId]);

  useEffect(() => {
    if (!isMallOperator) {
      setAccounts([]);
      return;
    }
    let mounted = true;
    setAdministratorLoading(true);
    void getPlatformAccounts()
      .then((next) => { if (mounted) setAccounts(next); })
      .catch((error) => { if (mounted) onNotice(error instanceof Error ? error.message : "账号列表读取失败"); })
      .finally(() => { if (mounted) setAdministratorLoading(false); });
    return () => { mounted = false; };
  }, [isMallOperator, onNotice]);

  const refresh = async () => {
    if (!organizationId) return;
    setDirectory(await getPlatformMembers(organizationId));
  };

  const invite = async () => {
    if (!organizationId || !email.trim()) {
      onNotice("请选择平台并填写成员邮箱");
      return;
    }
    setLoading(true);
    try {
      await invitePlatformMember({ organizationId, email: email.trim(), role: inviteRole });
      setEmail("");
      await refresh();
      onNotice("邀请已发送；对方接受后会自动加入这个平台");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "成员邀请失败");
    } finally {
      setLoading(false);
    }
  };

  const changeRole = async (member: PlatformMemberRecord, role: string) => {
    if (!organizationId || role === member.role) return;
    setBusyMemberId(member.id);
    try {
      await updatePlatformMember({ organizationId, memberId: member.id, role });
      await refresh();
      onNotice("成员权限已更新");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "成员权限更新失败");
    } finally {
      setBusyMemberId(null);
    }
  };

  const remove = async (member: PlatformMemberRecord) => {
    if (!organizationId) return;
    setBusyMemberId(member.id);
    try {
      await removePlatformMember({ organizationId, memberIdOrEmail: member.user?.email || member.userId });
      await refresh();
      onNotice("成员已移出平台");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "成员移除失败");
    } finally {
      setBusyMemberId(null);
    }
  };

  const issueAdministratorInvite = async () => {
    if (!administratorInviteEmail.trim()) {
      onNotice("请填写商城运营人员邮箱");
      return;
    }
    setAdministratorLoading(true);
    try {
      const invite = await createPlatformAdminInvite({ email: administratorInviteEmail.trim(), expiresHours: 24 });
      setAdministratorInviteEmail("");
      setNewAdministratorInvite(invite);
      onNotice("商城运营注册链接已生成；请通过安全渠道发送给指定邮箱");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "商城运营邀请创建失败");
    } finally {
      setAdministratorLoading(false);
    }
  };

  const createApiKey = async () => {
    if (!organizationId || !apiKeyName.trim()) {
      onNotice("请填写 API Key 名称");
      return;
    }
    setApiKeyLoading(true);
    try {
      const created = await createPlatformApiKey({
        organizationId,
        name: apiKeyName.trim(),
        ...(apiKeySide === "none" ? {} : {
          agentSide: apiKeySide,
          // The hosted platform router is a read-only tree lookup. Keep it explicit alongside the
          // marketplace write capability so the generated key can run the documented buyer/seller
          // flow without granting configuration or member-management actions.
          permissions: {
            platform: ["read"],
            retrieval: ["query"],
            media: ["upload"],
            marketplace: ["read", "write"],
            agent: ["handoff", "tool"],
          },
        }),
      });
      setApiKeyName("");
      setNewApiKeySecret(created.key || null);
      setApiKeys(await getPlatformApiKeys(organizationId));
      onNotice("API Key 已创建；完整密钥只显示这一次");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "API Key 创建失败");
    } finally {
      setApiKeyLoading(false);
    }
  };

  const toggleApiKey = async (key: PlatformApiKeyRecord) => {
    if (!organizationId) return;
    setApiKeyLoading(true);
    try {
      await updatePlatformApiKey({ organizationId, keyId: key.id, enabled: !key.enabled });
      setApiKeys(await getPlatformApiKeys(organizationId));
      onNotice(key.enabled ? "API Key 已停用" : "API Key 已启用");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "API Key 状态更新失败");
    } finally {
      setApiKeyLoading(false);
    }
  };

  const revokeApiKey = async (key: PlatformApiKeyRecord) => {
    if (!organizationId) return;
    setApiKeyLoading(true);
    try {
      await revokePlatformApiKey({ organizationId, keyId: key.id });
      setApiKeys(await getPlatformApiKeys(organizationId));
      onNotice("API Key 已撤销");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "API Key 撤销失败");
    } finally {
      setApiKeyLoading(false);
    }
  };

  const createOidc = async () => {
    if (!oidcRegistrationId || !oidcName.trim() || !oidcRedirectUri.trim()) {
      onNotice("请选择已上线店铺，并填写客户端名称和 HTTPS 回调地址");
      return;
    }
    setOidcLoading(true);
    try {
      const created = await createPlatformOidcClient({
        subplatformRegistrationId: oidcRegistrationId,
        clientName: oidcName.trim(),
        redirectUris: [oidcRedirectUri.trim()],
      });
      setOidcName("");
      setOidcRedirectUri("");
      setNewOidcSecret(created.clientSecret || created.client_secret || null);
      setOidcClients(await getPlatformOidcClients());
      onNotice("OIDC 客户端已创建；secret 只显示这一次");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "OIDC 客户端创建失败");
    } finally {
      setOidcLoading(false);
    }
  };

  const toggleOidc = async (client: PlatformOidcClientRecord) => {
    setOidcLoading(true);
    try {
      await updatePlatformOidcClient({ clientId: client.clientId, action: client.disabled ? "enable" : "disable" });
      setOidcClients(await getPlatformOidcClients());
      onNotice(client.disabled ? "OIDC 客户端已启用" : "OIDC 客户端已停用");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "OIDC 客户端状态更新失败");
    } finally {
      setOidcLoading(false);
    }
  };

  const refreshFederation = async () => {
    setFederationBindings(await getFederationBindings());
  };

  const issueFederationInvite = async () => {
    if (!federationDomainId) {
      onNotice("请先创建并选择一个启用中的 domain");
      return;
    }
    setFederationLoading(true);
    try {
      const invite = await createFederationInvite({
        domainId: federationDomainId,
        expiresInHours: Math.max(1, Math.min(168, Number.parseInt(federationExpiresHours, 10) || 24)),
      });
      setNewFederationInvite({ token: invite.enrollmentToken, url: invite.enrollmentUrl, expiresAt: invite.expiresAt });
      await refreshFederation();
      onNotice("联邦邀请已创建；token 只显示这一次");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "联邦邀请创建失败");
    } finally {
      setFederationLoading(false);
    }
  };

  const activateFederation = async (binding: FederationBindingRecord) => {
    setFederationLoading(true);
    try {
      await activateFederationBinding({
        bindingId: binding.id,
        tokenEnv: federationTokenEnv[binding.id]?.trim() || defaultFederationTokenEnv(binding.slug),
        membershipPolicy: "invite",
      });
      await refreshFederation();
      onNotice(`店铺 /${binding.slug} 已上线，现在可以被商品搜索检索`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "联邦节点激活失败");
    } finally {
      setFederationLoading(false);
    }
  };

  const revokeFederation = async (binding: FederationBindingRecord) => {
    setFederationLoading(true);
    try {
      await revokeFederationBinding(binding.id);
      await refreshFederation();
      onNotice(`/${binding.slug} 已撤销`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "联邦节点撤销失败");
    } finally {
      setFederationLoading(false);
    }
  };

  const probeFederation = async (binding: FederationBindingRecord) => {
    setFederationLoading(true);
    try {
      const result = await probeFederationBinding(binding.id);
      await refreshFederation();
      onNotice(result.status === "active" ? `/${binding.slug} 连接正常` : `/${binding.slug} 暂不可用，已标记 degraded`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "联邦节点健康检查失败");
    } finally {
      setFederationLoading(false);
    }
  };

  return (
    <section className="surface platform-access-panel" aria-labelledby="platform-access-title">
      <div className="subplatform-header">
        <div>
          <p className="eyebrow"><Users size={14} aria-hidden="true" /> {storeOnlyScope ? "店铺团队" : "团队与账号"}</p>
          <h2 id="platform-access-title">{storeOnlyScope ? "店长和店员" : "管理团队，也看得见用户"}</h2>
          <p className="subplatform-intro">{storeOnlyScope ? "店长负责店铺和团队；店员可以上架商品、处理日常经营，不能管理商城。" : "账号目录用于查看商城注册用户；团队成员才拥有商城或店铺的运营权限。"}</p>
        </div>
        {organizations.length && (!isMallOperator || accessView === "team") ? (
          <label className="platform-access-select"><span>管理范围</span><select value={organizationId} onChange={(event) => setOrganizationId(event.target.value)}>{organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.isRoot ? "商城" : "店铺"} · {organization.name}</option>)}</select></label>
        ) : null}
      </div>
      {isMallOperator ? (
        <div className="platform-access-view-tabs" role="tablist" aria-label="商城账号与团队">
          <button id="platform-access-tab-accounts" type="button" role="tab" aria-selected={accessView === "accounts"} aria-controls="platform-access-accounts" className={accessView === "accounts" ? "is-active" : ""} onClick={() => setAccessView("accounts")}>商城账号</button>
          <button id="platform-access-tab-team" type="button" role="tab" aria-selected={accessView === "team"} aria-controls="platform-access-team" className={accessView === "team" ? "is-active" : ""} onClick={() => setAccessView("team")}>团队成员</button>
        </div>
      ) : null}
      {isMallOperator && accessView === "accounts" ? (
        <section id="platform-access-accounts" className="mall-account-directory" role="tabpanel" aria-labelledby="platform-access-tab-accounts">
          <div className="mall-account-directory-heading">
            <div>
              <p className="eyebrow">商城账号</p>
              <h3>所有已注册用户</h3>
              <p>普通顾客、店主和商城运营人员都会显示在这里。查看账号不会授予店铺权限。</p>
            </div>
            <small>{administratorLoading ? "正在读取…" : `${accounts.length} 个账号`}</small>
          </div>
          <div className="mall-account-summary" aria-label="账号统计">
            <span><strong>{ordinaryAccountCount}</strong>普通用户</span>
            <span><strong>{accounts.filter((account) => account.role === "rootAdmin").length}</strong>商城运营</span>
            <span><strong>{accounts.filter((account) => account.role === "rootSuperAdmin").length}</strong>商城负责人</span>
          </div>
          <label className="mall-account-search">
            <Search size={16} aria-hidden="true" />
            <span>查找账号</span>
            <input value={accountSearch} onChange={(event) => setAccountSearch(event.target.value)} placeholder="按姓名或邮箱搜索" autoComplete="off" />
          </label>
          <div className="root-administrator-list" aria-label="商城账号目录">
            {filteredAccounts.length ? filteredAccounts.map((account) => (
              <div className="root-administrator-row" key={account.id}>
                <span><strong>{account.name || account.email}</strong><small>{account.email}{account.emailVerified ? " · 邮箱已验证" : " · 邮箱待验证"}{account.createdAt ? ` · 注册于 ${new Date(account.createdAt).toLocaleDateString()}` : ""}</small></span>
                <b className={account.role === "rootSuperAdmin" || account.role === "rootAdmin" ? "status-chip is-on" : "status-chip"}>{accountRoleLabel(account.role)}</b>
              </div>
            )) : <p className="platform-access-empty">{administratorLoading ? "正在读取账号…" : accountSearch.trim() ? "没有匹配的账号。" : "还没有注册账号。"}</p>}
          </div>
          <div className="root-administrator-panel">
            <div className="subsection-heading"><div><p className="eyebrow">商城团队</p><strong>邀请商城运营</strong></div><small>{rootRole === "rootSuperAdmin" ? "商城运营通过一次性注册链接加入" : "只有商城负责人可以创建邀请"}</small></div>
            {rootRole === "rootSuperAdmin" ? <div className="platform-access-invite"><label><span>运营人员邮箱</span><input type="email" value={administratorInviteEmail} onChange={(event) => setAdministratorInviteEmail(event.target.value)} placeholder="operator@example.com" /></label><button className="button button-dark" type="button" disabled={administratorLoading} onClick={() => void issueAdministratorInvite()}>创建注册链接</button></div> : null}
            {newAdministratorInvite ? <div className="api-key-secret"><div><strong>仅发给 {newAdministratorInvite.email}</strong><code>{newAdministratorInvite.registrationUrl}</code><small>到期 {new Date(newAdministratorInvite.expiresAt).toLocaleString()}</small></div><button type="button" onClick={() => void copySecret(newAdministratorInvite.registrationUrl)}>复制</button><button type="button" onClick={() => setNewAdministratorInvite(null)}>关闭</button></div> : null}
          </div>
        </section>
      ) : (
        <div id="platform-access-team" role={isMallOperator ? "tabpanel" : undefined} aria-labelledby={isMallOperator ? "platform-access-tab-team" : undefined}>
      {!organizations.length ? (
        <div className="subplatform-empty"><ShieldCheck size={22} aria-hidden="true" /><p>还没有可管理的商城团队或店铺。</p></div>
      ) : (
        <>
          <div className="platform-access-invite">
            <label><span>成员邮箱</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="operator@your-company.cn" autoComplete="email" /></label>
            <label><span>加入角色</span><select value={inviteRole} onChange={(event) => setInviteRole(event.target.value)}>{roleOptions(directory?.canAssignOwner === true).map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}</select></label>
            <button className="button button-dark" type="button" disabled={loading} onClick={() => void invite()}><MailPlus size={16} aria-hidden="true" />{loading ? "处理中…" : "发送邀请"}</button>
          </div>
          {selectedOrganization && directory ? (
            <div className="platform-member-list" aria-label="平台成员列表">
              {directory.members.length ? directory.members.map((member) => (
                <div className="platform-member-row" key={member.id}>
                  <span className="platform-member-avatar" aria-hidden="true">{(member.user?.name || member.user?.email || "?").slice(0, 1).toUpperCase()}</span>
                  <span className="platform-member-copy"><strong>{member.user?.name || member.user?.email || member.userId}</strong><small>{member.user?.email || member.userId}</small></span>
                  <select aria-label={`${member.user?.email || member.userId} 的角色`} value={member.role.split(",")[0]} disabled={busyMemberId === member.id} onChange={(event) => void changeRole(member, event.target.value)}>{roleOptions(directory.canAssignOwner).map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}</select>
                  <button className="icon-button" type="button" aria-label={`移除 ${member.user?.email || member.userId}`} disabled={busyMemberId === member.id} onClick={() => void remove(member)}><UserMinus size={16} aria-hidden="true" /></button>
                </div>
              )) : <p className="platform-access-empty">这个团队还没有成员。</p>}
            </div>
          ) : <p className="platform-access-empty">{loading ? "正在读取成员…" : "选择商城或店铺读取成员"}</p>}
          {directory?.invitations.filter((invitation) => invitation.status === "pending").length ? (
            <div className="platform-invitation-list">
              <p className="eyebrow">待处理邀请</p>
              {directory.invitations.filter((invitation) => invitation.status === "pending").map((invitation) => (
                <div className="platform-invitation-row" key={invitation.id}><span>{invitation.email}</span><small>{roleLabel(invitation.role)}</small><button type="button" onClick={() => void removeInvitation(invitation.id)}>撤回</button></div>
              ))}
            </div>
          ) : null}
          <div className="platform-api-key-panel">
            <div className="subsection-heading"><div><p className="eyebrow">Agent / MCP 接入</p><strong>平台 API Key</strong></div><small>{apiKeyLoading ? "处理中…" : "密钥只在创建时显示完整值"}</small></div>
            <div className="platform-api-key-form">
              <label><span>名称</span><input value={apiKeyName} onChange={(event) => setApiKeyName(event.target.value)} placeholder="例如：供应方 Agent" autoComplete="off" /></label>
              <label><span>用途</span><select value={apiKeySide} onChange={(event) => setApiKeySide(event.target.value as typeof apiKeySide)}><option value="none">平台接口（只读）</option><option value="demand">需求方 Agent</option><option value="supply">供给方 Agent</option><option value="both">双向 Agent</option></select></label>
              <button className="button button-dark" type="button" disabled={apiKeyLoading} onClick={() => void createApiKey()}>创建 Key</button>
            </div>
            {newApiKeySecret ? <div className="api-key-secret"><div><strong>请立即保存这段密钥</strong><code>{newApiKeySecret}</code></div><button type="button" onClick={() => void copySecret(newApiKeySecret)}>复制</button><button type="button" onClick={() => setNewApiKeySecret(null)}>关闭</button></div> : null}
            <div className="platform-api-key-list" aria-label="平台 API Key 列表">
              {apiKeys.length ? apiKeys.map((key) => <div className="platform-api-key-row" key={key.id}><span><strong>{key.name || key.start || key.id.slice(0, 8)}</strong><small>{key.start ? `${key.prefix || ""}${key.start}…` : key.id} · {key.expiresAt ? `到期 ${new Date(key.expiresAt).toLocaleDateString()}` : "不过期"}</small></span><b className={key.enabled ? "status-chip is-on" : "status-chip"}>{key.enabled ? "启用" : "停用"}</b><button type="button" disabled={apiKeyLoading} onClick={() => void toggleApiKey(key)}>{key.enabled ? "停用" : "启用"}</button><button type="button" disabled={apiKeyLoading} onClick={() => void revokeApiKey(key)}>撤销</button></div>) : <p className="platform-access-empty">还没有 API Key。</p>}
            </div>
          </div>
          {(rootRole === "rootSuperAdmin" || rootRole === "rootAdmin") ? (
            <div className="platform-oidc-panel">
              <div className="subsection-heading"><div><p className="eyebrow">统一登录</p><strong>店铺 OIDC 客户端</strong></div><small>{oidcLoading ? "处理中…" : "只为已上线店铺签发"}</small></div>
              <div className="platform-oidc-form">
                <label><span>店铺</span><select value={oidcRegistrationId} onChange={(event) => setOidcRegistrationId(event.target.value)}><option value="">选择已上线店铺</option>{organizations.filter((organization) => organization.registrationId && organization.registrationState === "active").map((organization) => <option key={organization.registrationId} value={organization.registrationId!}>{organization.name}</option>)}</select></label>
                <label><span>客户端名称</span><input value={oidcName} onChange={(event) => setOidcName(event.target.value)} placeholder="店铺登录客户端" autoComplete="off" /></label>
                <label><span>HTTPS 回调地址</span><input value={oidcRedirectUri} onChange={(event) => setOidcRedirectUri(event.target.value)} placeholder="https://child.example.com/callback" inputMode="url" /></label>
                <button className="button button-dark" type="button" disabled={oidcLoading} onClick={() => void createOidc()}>创建客户端</button>
              </div>
              {newOidcSecret ? <div className="api-key-secret"><div><strong>请立即保存 OIDC secret</strong><code>{newOidcSecret}</code></div><button type="button" onClick={() => void copySecret(newOidcSecret)}>复制</button><button type="button" onClick={() => setNewOidcSecret(null)}>关闭</button></div> : null}
              <div className="platform-oidc-list" aria-label="OIDC 客户端列表">
                {oidcClients.length ? oidcClients.map((client) => <div className="platform-oidc-row" key={client.clientId}><span><strong>{client.clientName || client.clientId}</strong><small>{client.clientId} · {client.redirectUris.join(", ")}</small></span><b className={client.disabled ? "status-chip" : "status-chip is-on"}>{client.disabled ? "停用" : "启用"}</b><button type="button" disabled={oidcLoading} onClick={() => void toggleOidc(client)}>{client.disabled ? "启用" : "停用"}</button></div>) : <p className="platform-access-empty">还没有 OIDC 客户端。</p>}
              </div>
            </div>
          ) : null}
          {(rootRole === "rootSuperAdmin" || rootRole === "rootAdmin") ? (
            <div className="platform-federation-panel platform-api-key-panel">
              <div className="subsection-heading"><div><p className="eyebrow"><Globe2 size={14} aria-hidden="true" /> 外部店铺</p><strong>接入远程经营的店铺</strong></div><small>{federationLoading ? "处理中…" : "一次性签名入驻，人工上线"}</small></div>
              <p className="platform-access-empty">外部商家使用一次性 token 提交签名清单；商城仅获得店铺授权的商品检索能力。</p>
              <div className="platform-federation-form">
                <label><span>商品范围</span><select value={federationDomainId} onChange={(event) => setFederationDomainId(event.target.value)}><option value="">选择商品范围</option>{federationDomains.map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}</select></label>
                <label><span>邀请有效期（小时）</span><input type="number" min={1} max={168} value={federationExpiresHours} onChange={(event) => setFederationExpiresHours(event.target.value)} /></label>
                <button className="button button-dark" type="button" disabled={federationLoading} onClick={() => void issueFederationInvite()}>生成入驻 token</button>
              </div>
              {newFederationInvite ? <div className="api-key-secret"><div><strong>请立即交给外部店主</strong><code>{newFederationInvite.token}</code><small>POST {newFederationInvite.url} · 到期 {new Date(newFederationInvite.expiresAt).toLocaleString()}</small></div><button type="button" onClick={() => void copySecret(newFederationInvite.token)}>复制 token</button><button type="button" onClick={() => setNewFederationInvite(null)}>关闭</button></div> : null}
              <div className="platform-oidc-list" aria-label="外部店铺列表">
                {federationBindings.length ? federationBindings.map((binding) => (
                  <div className="platform-oidc-row platform-federation-row" key={binding.id}>
                    <span><strong>/{binding.slug} · {binding.displayName}</strong><small>{binding.endpoint} · {binding.status}</small></span>
                    {binding.status === "pending" ? <><input aria-label={`${binding.slug} 的 MCP token 环境变量`} value={federationTokenEnv[binding.id] ?? defaultFederationTokenEnv(binding.slug)} onChange={(event) => setFederationTokenEnv((current) => ({ ...current, [binding.id]: event.target.value }))} placeholder="MATCHPLANE_REMOTE_MCP_TOKEN" /><button type="button" disabled={federationLoading} onClick={() => void activateFederation(binding)}>激活</button></> : binding.status !== "revoked" ? <><button type="button" disabled={federationLoading} onClick={() => void probeFederation(binding)}>检查</button><button type="button" disabled={federationLoading} onClick={() => void revokeFederation(binding)}>撤销</button></> : <b className="status-chip">已撤销</b>}
                  </div>
                )) : <p className="platform-access-empty">还没有外部店铺入驻。</p>}
              </div>
            </div>
          ) : null}
        </>
      )}
        </div>
      )}
    </section>
  );

  async function removeInvitation(invitationId: string) {
    if (!organizationId) return;
    setLoading(true);
    try {
      await removePlatformMember({ organizationId, invitationId });
      await refresh();
      onNotice("邀请已撤回");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "邀请撤回失败");
    } finally {
      setLoading(false);
    }
  }
}

function roleOptions(canAssignOwner: boolean): Array<{ value: string; label: string }> {
  const roles = [
    { value: "admin", label: "店员" },
    { value: "moderator", label: "内容审核" },
    { value: "member", label: "仅查看" },
  ];
  return canAssignOwner ? [{ value: "owner", label: "店长" }, ...roles] : roles;
}

function roleLabel(role: string): string {
  if (role === "subplatform_admin") return "店员";
  return roleOptions(true).find((candidate) => candidate.value === role)?.label || role;
}

function accountRoleLabel(role: string): string {
  if (role === "rootSuperAdmin") return "商城负责人";
  if (role === "rootAdmin") return "商城运营";
  return "普通用户";
}

async function copySecret(secret: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(secret);
  } catch {
    // Clipboard permission is optional; the secret remains visible until the operator closes it.
  }
}

function defaultFederationTokenEnv(slug: string): string {
  const normalized = slug.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toUpperCase() || "REMOTE";
  return `MATCHPLANE_${normalized}_MCP_TOKEN`;
}

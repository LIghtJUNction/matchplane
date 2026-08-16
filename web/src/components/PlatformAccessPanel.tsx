import { useEffect, useMemo, useState } from "react";
import { MailPlus, ShieldCheck, UserMinus, Users } from "lucide-react";

import {
  createPlatformApiKey,
  createPlatformOidcClient,
  getPlatformAdministrators,
  getPlatformApiKeys,
  getPlatformMembers,
  getPlatformOidcClients,
  invitePlatformMember,
  removePlatformMember,
  revokePlatformApiKey,
  updatePlatformMember,
  updatePlatformApiKey,
  updatePlatformOidcClient,
  updatePlatformAdministrator,
  type PlatformAdministratorRecord,
  type PlatformApiKeyRecord,
  type PlatformOidcClientRecord,
  type PlatformMemberDirectory,
  type PlatformMemberRecord,
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
  const [organizationId, setOrganizationId] = useState("");
  const [directory, setDirectory] = useState<PlatformMemberDirectory | null>(null);
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("subplatform_admin");
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);
  const [administrators, setAdministrators] = useState<PlatformAdministratorRecord[]>([]);
  const [administratorLoading, setAdministratorLoading] = useState(false);
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

  const selectedOrganization = useMemo(
    () => organizations.find((organization) => organization.id === organizationId) ?? null,
    [organizationId, organizations],
  );

  useEffect(() => {
    if (!organizationId && organizations[0]) setOrganizationId(organizations[0].id);
    if (organizationId && !organizations.some((organization) => organization.id === organizationId)) {
      setOrganizationId(organizations[0]?.id ?? "");
    }
  }, [organizationId, organizations]);

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
    if (rootRole !== "rootSuperAdmin" && rootRole !== "rootAdmin") return;
    let mounted = true;
    setAdministratorLoading(true);
    void getPlatformAdministrators()
      .then((next) => { if (mounted) setAdministrators(next); })
      .catch((error) => { if (mounted) onNotice(error instanceof Error ? error.message : "账号列表读取失败"); })
      .finally(() => { if (mounted) setAdministratorLoading(false); });
    return () => { mounted = false; };
  }, [onNotice, rootRole]);

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

  const changeAdministratorRole = async (administrator: PlatformAdministratorRecord, role: "rootAdmin" | "user") => {
    setAdministratorLoading(true);
    try {
      await updatePlatformAdministrator({ userId: administrator.id, role });
      setAdministrators(await getPlatformAdministrators());
      onNotice(role === "rootAdmin" ? "根平台管理员权限已授予" : "根平台管理员权限已收回");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "根管理员权限更新失败");
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
          permissions: { marketplace: ["read", "write"], agent: ["handoff"] },
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
      onNotice("请选择已激活子平台，并填写客户端名称和 HTTPS 回调地址");
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

  return (
    <section className="surface platform-access-panel" aria-labelledby="platform-access-title">
      <div className="subplatform-header">
        <div>
          <p className="eyebrow"><Users size={14} aria-hidden="true" /> 统一身份与权限</p>
          <h2 id="platform-access-title">一个账号，管理它被授权的平台。</h2>
          <p className="subplatform-intro">成员只需要一个 Better Auth 账号；平台管理员在这里发邀请、调整角色或收回权限。</p>
        </div>
        {organizations.length ? (
          <label className="platform-access-select"><span>当前平台</span><select value={organizationId} onChange={(event) => setOrganizationId(event.target.value)}>{organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.isRoot ? "根平台" : `/${organization.slug}`} · {organization.name}</option>)}</select></label>
        ) : null}
      </div>
      {!organizations.length ? (
        <div className="subplatform-empty"><ShieldCheck size={22} aria-hidden="true" /><p>还没有可管理的平台组织；请先配置根平台组织或激活一个子平台。</p></div>
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
              )) : <p className="platform-access-empty">这个平台还没有成员。</p>}
            </div>
          ) : <p className="platform-access-empty">{loading ? "正在读取成员…" : "选择一个平台读取成员"}</p>}
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
              <div className="subsection-heading"><div><p className="eyebrow">联邦登录</p><strong>OIDC 客户端</strong></div><small>{oidcLoading ? "处理中…" : "只为已激活子平台签发"}</small></div>
              <div className="platform-oidc-form">
                <label><span>子平台</span><select value={oidcRegistrationId} onChange={(event) => setOidcRegistrationId(event.target.value)}><option value="">选择已激活子平台</option>{organizations.filter((organization) => organization.registrationId && organization.registrationState === "active").map((organization) => <option key={organization.registrationId} value={organization.registrationId!}>/{organization.slug} · {organization.name}</option>)}</select></label>
                <label><span>客户端名称</span><input value={oidcName} onChange={(event) => setOidcName(event.target.value)} placeholder="子平台登录客户端" autoComplete="off" /></label>
                <label><span>HTTPS 回调地址</span><input value={oidcRedirectUri} onChange={(event) => setOidcRedirectUri(event.target.value)} placeholder="https://child.example.com/callback" inputMode="url" /></label>
                <button className="button button-dark" type="button" disabled={oidcLoading} onClick={() => void createOidc()}>创建客户端</button>
              </div>
              {newOidcSecret ? <div className="api-key-secret"><div><strong>请立即保存 OIDC secret</strong><code>{newOidcSecret}</code></div><button type="button" onClick={() => void copySecret(newOidcSecret)}>复制</button><button type="button" onClick={() => setNewOidcSecret(null)}>关闭</button></div> : null}
              <div className="platform-oidc-list" aria-label="OIDC 客户端列表">
                {oidcClients.length ? oidcClients.map((client) => <div className="platform-oidc-row" key={client.clientId}><span><strong>{client.clientName || client.clientId}</strong><small>{client.clientId} · {client.redirectUris.join(", ")}</small></span><b className={client.disabled ? "status-chip" : "status-chip is-on"}>{client.disabled ? "停用" : "启用"}</b><button type="button" disabled={oidcLoading} onClick={() => void toggleOidc(client)}>{client.disabled ? "启用" : "停用"}</button></div>) : <p className="platform-access-empty">还没有 OIDC 客户端。</p>}
              </div>
            </div>
          ) : null}
        </>
      )}
      {rootRole === "rootSuperAdmin" || rootRole === "rootAdmin" ? (
        <div className="root-administrator-panel">
          <div className="subsection-heading"><div><p className="eyebrow">根平台账号</p><strong>管理员权限</strong></div><small>{administratorLoading ? "读取中…" : "账号先完成登录，再在这里授权"}</small></div>
          <div className="root-administrator-list" aria-label="根平台账号列表">
            {administrators.length ? administrators.map((administrator) => (
              <div className="root-administrator-row" key={administrator.id}>
                <span><strong>{administrator.name || administrator.email}</strong><small>{administrator.email}{administrator.emailVerified ? " · 已验证" : " · 待验证"}</small></span>
                {rootRole === "rootSuperAdmin" && administrator.role !== "rootSuperAdmin" ? <select value={administrator.role === "rootAdmin" ? "rootAdmin" : "user"} disabled={administratorLoading} aria-label={`${administrator.email} 的根平台权限`} onChange={(event) => void changeAdministratorRole(administrator, event.target.value as "rootAdmin" | "user")}><option value="user">普通账号</option><option value="rootAdmin">根平台管理员</option></select> : <b className="status-chip is-on">{administrator.role === "rootSuperAdmin" ? "超级管理员" : administrator.role === "rootAdmin" ? "管理员" : "普通账号"}</b>}
              </div>
            )) : <p className="platform-access-empty">{administratorLoading ? "正在读取账号…" : "还没有可管理的账号"}</p>}
          </div>
        </div>
      ) : null}
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
    { value: "admin", label: "管理员" },
    { value: "subplatform_admin", label: "平台管理员" },
    { value: "moderator", label: "运营管理员" },
    { value: "member", label: "普通成员" },
  ];
  return canAssignOwner ? [{ value: "owner", label: "平台所有者" }, ...roles] : roles;
}

function roleLabel(role: string): string {
  return roleOptions(true).find((candidate) => candidate.value === role)?.label || role;
}

async function copySecret(secret: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(secret);
  } catch {
    // Clipboard permission is optional; the secret remains visible until the operator closes it.
  }
}

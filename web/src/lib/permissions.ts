import { createAccessControl } from "better-auth/plugins/access";
import {
  adminAc as betterAuthAdminAc,
  defaultStatements as betterAuthAdminStatements,
} from "better-auth/plugins/admin/access";
import {
  adminAc as organizationAdminAc,
  defaultStatements as organizationStatements,
  memberAc as organizationMemberAc,
  ownerAc as organizationOwnerAc,
} from "better-auth/plugins/organization/access";

const adminStatement = {
  ...betterAuthAdminStatements,
  platform: ["read", "configure", "manage_members", "manage_roles"] as const,
} as const;

export const adminAccessControl = createAccessControl(adminStatement);

/** Root-wide administrator. The only role allowed to administer every subplatform. */
export const rootSuperAdmin = adminAccessControl.newRole({
  ...betterAuthAdminAc.statements,
  platform: ["read", "configure", "manage_members", "manage_roles"],
});

/** Root platform operator. It can operate the platform but cannot change root roles. */
export const rootAdmin = adminAccessControl.newRole({
  user: ["list", "get", "update"],
  session: ["list", "revoke"],
  platform: ["read", "configure"],
});

const organizationStatement = {
  ...organizationStatements,
  apiKey: ["create", "read", "update", "delete"] as const,
  marketplace: ["read", "submit", "moderate", "publish"] as const,
  subplatform: ["read", "configure", "manage_members", "manage_roles"] as const,
} as const;

export const organizationAccessControl = createAccessControl(organizationStatement);

export const organizationOwner = organizationAccessControl.newRole({
  ...organizationOwnerAc.statements,
  apiKey: ["create", "read", "update", "delete"],
  marketplace: ["read", "submit", "moderate", "publish"],
  subplatform: ["read", "configure", "manage_members", "manage_roles"],
});

/** Scoped subplatform administrator; its authority never crosses organization boundaries. */
export const subplatformAdmin = organizationAccessControl.newRole({
  ...organizationAdminAc.statements,
  apiKey: ["create", "read", "update", "delete"],
  marketplace: ["read", "submit", "moderate", "publish"],
  subplatform: ["read", "configure", "manage_members", "manage_roles"],
});

export const subplatformModerator = organizationAccessControl.newRole({
  ...organizationMemberAc.statements,
  marketplace: ["read", "moderate", "publish"],
  subplatform: ["read"],
});

export const subplatformMember = organizationAccessControl.newRole({
  ...organizationMemberAc.statements,
  marketplace: ["read", "submit"],
  subplatform: ["read"],
});

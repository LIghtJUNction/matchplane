"use client";

import { createAuthClient } from "better-auth/react";
import { apiKeyClient } from "@better-auth/api-key/client";
import { adminClient, organizationClient } from "better-auth/client/plugins";

import {
  adminAccessControl,
  organizationAccessControl,
  organizationOwner,
  rootAdmin,
  rootSuperAdmin,
  subplatformAdmin,
  subplatformMember,
  subplatformModerator,
} from "./permissions";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_BETTER_AUTH_URL ?? undefined,
  fetchOptions: {
    credentials: "include",
  },
  plugins: [
    apiKeyClient(),
    adminClient({
      ac: adminAccessControl,
      roles: { rootSuperAdmin, rootAdmin },
    }),
    organizationClient({
      ac: organizationAccessControl,
      roles: {
        owner: organizationOwner,
        admin: subplatformAdmin,
        subplatform_admin: subplatformAdmin,
        moderator: subplatformModerator,
        member: subplatformMember,
      },
      dynamicAccessControl: { enabled: true },
    }),
  ],
});

export function authFetchOptions(subplatform: string) {
  return {
    headers: { "x-matchplane-subplatform": subplatform },
    credentials: "include" as const,
  };
}

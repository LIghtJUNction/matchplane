import { NextResponse } from "next/server";

import {
    configuredFallbackOAuthProviderIds,
    configuredPrimaryOAuthProviderIds,
    auth,
} from "../../../../../src/lib/auth";
import { isRootEmailAuthConfigured } from "../../../../../src/lib/mail";
import { isPhoneOtpConfigured } from "../../../../../src/lib/sms";
import { hasTrustedBrowserOrigin } from "../../../../../src/lib/request-origin";
import { isPlatformRouterConfigured } from "../../../../../src/platform-router";
import { getManagedPlatformRouterState } from "../../../../../src/lib/platform-router-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-side capability summary for the administrator workspace.
 *
 * This endpoint deliberately returns no provider key, secret, full URL path, or OAuth
 * endpoint. Secrets stay in the service environment/secret manager; the UI only needs to
 * show whether the deployment is ready and which safe, operator-controlled knobs remain.
 */
export async function GET(request: Request): Promise<Response> {
    if (!hasTrustedBrowserOrigin(request)) {
        return NextResponse.json(
            { error: "请求来源未被平台信任" },
            { status: 403 },
        );
    }
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session)
        return NextResponse.json(
            { error: "Better Auth session is required" },
            { status: 401 },
        );
    const role = (session.user as { role?: string | null }).role;
    if (role !== "rootSuperAdmin" && role !== "rootAdmin") {
        return NextResponse.json(
            { error: "只有根平台管理员可以查看运行时配置" },
            { status: 403 },
        );
    }

    const emailAuth = await isRootEmailAuthConfigured();
    const state = getManagedPlatformRouterState();
    const endpoint = state.effective.endpointOrigin;
    const model = state.effective.model;
    const toolMode = parseToolMode(process.env.MATCHPLANE_ROUTER_AI_TOOL_MODE);
    return NextResponse.json(
        {
            router: {
                configured: isPlatformRouterConfigured(),
                aiReady: state.effective.ready,
                protocol: state.effective.protocol,
                model,
                endpointOrigin: endpoint,
                source: state.effective.source,
                managedOverridesEnvironment:
                    state.effective.managedOverridesEnvironment,
                conflicts: state.effective.conflicts,
                credentialConfigured: state.effective.credentialConfigured,
                policyCode: state.effective.code,
                policyIssues: state.effective.issues,
                originAllowlistApplied:
                    state.effective.originAllowlistApplied,
                toolMode,
                maxInputCharacters: 24_000,
                maxOutputTokens: boundedInteger(
                    process.env.MATCHPLANE_ROUTER_AI_MAX_TOKENS,
                    512,
                    64,
                    2_048,
                ),
                totalTimeoutMs: boundedInteger(
                    process.env.MATCHPLANE_ROUTER_AI_TOTAL_TIMEOUT_MS,
                    20_000,
                    4_000,
                    60_000,
                ),
                maxSteps: boundedInteger(
                    process.env.MATCHPLANE_ROUTER_AI_MAX_STEPS,
                    8,
                    1,
                    16,
                ),
                maxFanout: boundedInteger(
                    process.env.MATCHPLANE_ROUTER_AI_MAX_FANOUT,
                    4,
                    1,
                    16,
                ),
                requestsPerHour: boundedInteger(
                    process.env.MATCHPLANE_ROUTER_AI_REQUESTS_PER_HOUR,
                    120,
                    1,
                    10_000,
                ),
                globalRequestsPerHour: boundedInteger(
                    process.env.MATCHPLANE_ROUTER_AI_GLOBAL_REQUESTS_PER_HOUR,
                    120,
                    1,
                    100_000,
                ),
            },
            auth: {
                primary: configuredPrimaryOAuthProviderIds(),
                fallback: configuredFallbackOAuthProviderIds(),
                password: true,
                emailOtp: emailAuth,
                phoneOtp: isPhoneOtpConfigured(),
                magicLink: emailAuth,
                passkey: true,
            },
        },
        { headers: { "cache-control": "no-store" } },
    );
}

function parseToolMode(
    value: string | undefined,
): "auto" | "required" | "disabled" {
    const normalized = value?.trim().toLowerCase();
    return normalized === "required" || normalized === "disabled"
        ? normalized
        : "auto";
}

function boundedInteger(
    value: string | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
): number {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isSafeInteger(parsed)
        ? Math.max(minimum, Math.min(maximum, parsed))
        : fallback;
}

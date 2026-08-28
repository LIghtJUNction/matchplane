import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticatePlatformRequest: vi.fn(),
  hasTrustedBrowserOrigin: vi.fn(),
  isActivePlatformPathVisible: vi.fn(),
  isMountedPlatformPath: vi.fn(),
  isPlatformPathAccessibleByOrganization: vi.fn(),
  query: vi.fn(),
  readActiveDirectChildRoutes: vi.fn(),
}));

vi.mock("./lib/auth", () => ({
  authDatabase: { query: mocks.query },
}));
vi.mock("./lib/request-origin", () => ({
  hasTrustedBrowserOrigin: mocks.hasTrustedBrowserOrigin,
}));
vi.mock("./platform-child-routes", () => ({
  readActiveDirectChildRoutes: mocks.readActiveDirectChildRoutes,
}));
vi.mock("./platform-mount", () => ({
  isMountedPlatformPath: mocks.isMountedPlatformPath,
  isPlatformPathAccessibleByOrganization:
    mocks.isPlatformPathAccessibleByOrganization,
}));
vi.mock("./platform-request-auth", () => ({
  authenticatePlatformRequest: mocks.authenticatePlatformRequest,
}));
vi.mock("./platform-visibility", () => ({
  isActivePlatformPathVisible: mocks.isActivePlatformPathVisible,
}));

import { POST } from "../app/api/platform/agent/handoff/route";

const requestId = "123e4567-e89b-42d3-a456-426614174000";
const sessionSubject = "223e4567-e89b-42d3-a456-426614174000";
const integrationSubject = "integration-subject-fixture";
const otherSessionSubject = "423e4567-e89b-42d3-a456-426614174000";
const validHandoff = {
  protocol: "matchplane.agent/v1",
  request_id: requestId,
  stage: "platform",
  scope: { platform_path: "/" },
  intent: {
    narrative: "寻找满足交付要求的供给",
    requirements: {
      delivery: { days: 7 },
      categories: ["industrial"],
    },
  },
  agent: {
    id: "buyer.example",
    version: "1.0.0",
    capabilities: ["search", "rank"],
  },
  budget: {
    max_steps: 8,
    max_input_characters: 24_000,
    max_output_tokens: 512,
    cost_bearer: "caller",
  },
  selected_refs: ["offer:one"],
};

const defaultActor = {
  subject: sessionSubject,
  access: "session",
  organizationId: null,
  isRootAdministrator: false,
};

interface ConflictRow {
  requestId: string;
  authSubject: string;
  status: string;
  expiresAt: string;
  sameOrganization: boolean;
  samePlatformPath: boolean;
  sameStage: boolean;
  sameNarrative: boolean;
  sameRequirements: boolean;
  sameAgent: boolean;
  sameBudget: boolean;
  sameSelectedRefs: boolean;
}

const matchingConflictRow: ConflictRow = {
  requestId,
  authSubject: sessionSubject,
  status: "completed",
  expiresAt: "2026-08-29T12:34:56.000Z",
  sameOrganization: true,
  samePlatformPath: true,
  sameStage: true,
  sameNarrative: true,
  sameRequirements: true,
  sameAgent: true,
  sameBudget: true,
  sameSelectedRefs: true,
};

function mockExistingHandoff(overrides: Partial<ConflictRow> = {}): void {
  mocks.query
    .mockResolvedValueOnce({ rowCount: 0, rows: [] })
    .mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ ...matchingConflictRow, ...overrides }],
    });
}

function request(body: unknown): Request {
  return new Request("https://matchplane.test/api/platform/agent/handoff", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://matchplane.test",
    },
    body: JSON.stringify(body),
  });
}

async function expectReplayConflict(
  body: unknown,
  comparison: Partial<ConflictRow>,
  error: string,
): Promise<void> {
  mockExistingHandoff(comparison);

  const response = await POST(request(body));

  expect(response.status).toBe(409);
  expect(response.headers.get("x-matchplane-idempotent")).toBeNull();
  await expect(response.json()).resolves.toEqual({ error });
}

describe("platform Agent handoff route idempotency", () => {
  beforeEach(() => {
    vi.stubEnv("MATCHPLANE_ROOT_TENANT_ID", "");
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.hasTrustedBrowserOrigin.mockReturnValue(true);
    mocks.authenticatePlatformRequest.mockResolvedValue(defaultActor);
    mocks.isMountedPlatformPath.mockResolvedValue(true);
    mocks.isPlatformPathAccessibleByOrganization.mockResolvedValue(true);
    mocks.isActivePlatformPathVisible.mockResolvedValue(true);
    mocks.readActiveDirectChildRoutes.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns the persisted result for an exact semantic replay", async () => {
    mockExistingHandoff();

    const response = await POST(request(validHandoff));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-matchplane-idempotent")).toBe("true");
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        requestId,
        status: matchingConflictRow.status,
        expiresAt: matchingConflictRow.expiresAt,
        budget: expect.objectContaining({ maxOutputTokens: 512 }),
      }),
    );

    const conflictQuery = mocks.query.mock.calls[1];
    expect(conflictQuery?.[0]).toContain(
      'requirements = $6::jsonb AS "sameRequirements"',
    );
    expect(conflictQuery?.[0]).toContain('budget = $8::jsonb AS "sameBudget"');
    expect(conflictQuery?.[1]).toEqual([
      requestId,
      null,
      "/",
      "platform",
      "寻找满足交付要求的供给",
      JSON.stringify(validHandoff.intent.requirements),
      JSON.stringify(validHandoff.agent),
      JSON.stringify({
        maxSteps: 8,
        maxInputCharacters: 24_000,
        maxOutputTokens: 512,
        costBearer: "caller",
      }),
      JSON.stringify(["offer:one"]),
    ]);
  });

  it.each([
    {
      field: "budget",
      body: {
        ...validHandoff,
        budget: { ...validHandoff.budget, max_output_tokens: 1024 },
      },
      actor: defaultActor,
      comparison: { sameBudget: false },
      sqlFragment: 'budget = $8::jsonb AS "sameBudget"',
      parameterIndex: 7,
      expectedParameter: JSON.stringify({
        maxSteps: 8,
        maxInputCharacters: 24_000,
        maxOutputTokens: 1024,
        costBearer: "caller",
      }),
    },
    {
      field: "requirements",
      body: {
        ...validHandoff,
        intent: {
          ...validHandoff.intent,
          requirements: {
            ...validHandoff.intent.requirements,
            delivery: { days: 3 },
          },
        },
      },
      actor: defaultActor,
      comparison: { sameRequirements: false },
      sqlFragment: 'requirements = $6::jsonb AS "sameRequirements"',
      parameterIndex: 5,
      expectedParameter: JSON.stringify({
        delivery: { days: 3 },
        categories: ["industrial"],
      }),
    },
    {
      field: "narrative",
      body: {
        ...validHandoff,
        intent: { ...validHandoff.intent, narrative: "寻找另一类供给" },
      },
      actor: defaultActor,
      comparison: { sameNarrative: false },
      sqlFragment: 'narrative = $5 AS "sameNarrative"',
      parameterIndex: 4,
      expectedParameter: "寻找另一类供给",
    },
    {
      field: "agent",
      body: {
        ...validHandoff,
        agent: { ...validHandoff.agent, version: "2.0.0" },
      },
      actor: defaultActor,
      comparison: { sameAgent: false },
      sqlFragment: 'agent = $7::jsonb AS "sameAgent"',
      parameterIndex: 6,
      expectedParameter: JSON.stringify({
        id: "buyer.example",
        version: "2.0.0",
        capabilities: ["search", "rank"],
      }),
    },
    {
      field: "selected_refs",
      body: { ...validHandoff, selected_refs: ["offer:two"] },
      actor: defaultActor,
      comparison: { sameSelectedRefs: false },
      sqlFragment: 'selected_refs = $9::jsonb AS "sameSelectedRefs"',
      parameterIndex: 8,
      expectedParameter: JSON.stringify(["offer:two"]),
    },
    {
      field: "organization",
      body: validHandoff,
      actor: {
        ...defaultActor,
        subject: integrationSubject,
        access: "api_key",
        organizationId: "223e4567-e89b-42d3-a456-426614174000",
      },
      comparison: {
        authSubject: integrationSubject,
        sameOrganization: false,
      },
      sqlFragment:
        'organization_id IS NOT DISTINCT FROM $2::uuid AS "sameOrganization"',
      parameterIndex: 1,
      expectedParameter: "223e4567-e89b-42d3-a456-426614174000",
    },
  ])("rejects a replay that changes persisted $field", async ({
    body,
    actor,
    comparison,
    sqlFragment,
    parameterIndex,
    expectedParameter,
  }) => {
    mocks.authenticatePlatformRequest.mockResolvedValue(actor);

    await expectReplayConflict(
      body,
      comparison,
      "同一 request_id 不能改变 handoff payload",
    );

    const conflictQuery = mocks.query.mock.calls[1];
    expect(conflictQuery?.[0]).toContain(sqlFragment);
    expect(conflictQuery?.[1]?.[parameterIndex]).toEqual(expectedParameter);
  });

  it.each([
    {
      field: "platform path",
      body: {
        ...validHandoff,
        scope: { platform_path: "/industrial" },
      },
      comparison: { samePlatformPath: false },
      sqlFragment: 'platform_path = $3 AS "samePlatformPath"',
      parameterIndex: 2,
      expectedParameter: "/industrial",
    },
    {
      field: "stage",
      body: { ...validHandoff, stage: "profile.compatibility" },
      comparison: { sameStage: false },
      sqlFragment: 'stage = $4 AS "sameStage"',
      parameterIndex: 3,
      expectedParameter: "profile.compatibility",
    },
  ])("rejects a replay that changes $field scope", async ({
    body,
    comparison,
    sqlFragment,
    parameterIndex,
    expectedParameter,
  }) => {
    await expectReplayConflict(
      body,
      comparison,
      "同一 request_id 不能改变 handoff 范围",
    );

    const conflictQuery = mocks.query.mock.calls[1];
    expect(conflictQuery?.[0]).toContain(sqlFragment);
    expect(conflictQuery?.[1]?.[parameterIndex]).toEqual(expectedParameter);
  });

  it("rejects a request_id replay from another auth subject", async () => {
    mocks.authenticatePlatformRequest.mockResolvedValue({
      ...defaultActor,
      subject: otherSessionSubject,
    });

    await expectReplayConflict(
      validHandoff,
      {},
      "request_id 已被其他 Agent 使用",
    );
  });
});

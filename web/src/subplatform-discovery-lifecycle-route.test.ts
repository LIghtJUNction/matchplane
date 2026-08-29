import { beforeEach, describe, expect, it, vi } from "vitest";

const { databaseQuery, hasBuilderToken } = vi.hoisted(() => ({
  databaseQuery: vi.fn(),
  hasBuilderToken: vi.fn(),
}));

vi.mock("./lib/auth", () => ({
  authDatabase: { query: databaseQuery },
}));
vi.mock("./subplatform-builder", () => ({
  hasValidConfiguredSubplatformBuilderToken: hasBuilderToken,
}));

import { POST as claimDiscovery } from "../app/api/platform/subplatforms/discover/claim/route";
import { POST as failDiscovery } from "../app/api/platform/subplatforms/discover/fail/route";

const intakeId = "123e4567-e89b-42d3-a456-426614174000";
const leaseId = "223e4567-e89b-42d3-a456-426614174000";

function builderRequest(path: string, body?: Record<string, unknown>): Request {
  return new Request(`https://matx.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-matchplane-builder-token": "test-token",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe("subplatform discovery lease lifecycle", () => {
  beforeEach(() => {
    databaseQuery.mockReset();
    hasBuilderToken.mockReset();
    hasBuilderToken.mockResolvedValue(true);
  });

  it("rejects the twentieth failed lease instead of leaving an unclaimable queued job", async () => {
    let state: "queued" | "discovering" | "rejected" = "queued";
    let attempts = 19;
    let activeLease: string | null = null;

    databaseQuery.mockImplementation(
      async (statement: string, parameters: unknown[] = []) => {
        if (statement.includes("WITH candidate AS")) {
          if (state !== "queued" || attempts >= 20) {
            return { rowCount: 0, rows: [] };
          }
          state = "discovering";
          attempts += 1;
          activeLease = leaseId;
          return {
            rowCount: 1,
            rows: [{
              id: intakeId,
              leaseId,
              discoverAttempts: attempts,
              sourceKind: "archive",
              sourceLocator: `upload://${intakeId}`,
            }],
          };
        }
        if (statement.includes("UPDATE subplatform_source_intakes")) {
          expect(statement).toContain(
            "WHEN $4::boolean AND discover_attempts < 20 THEN 'queued'",
          );
          if (
            state !== "discovering" ||
            parameters[0] !== intakeId ||
            parameters[1] !== activeLease
          ) {
            return { rowCount: 0, rows: [] };
          }
          state = parameters[3] === true && attempts < 20 ? "queued" : "rejected";
          activeLease = null;
          return { rowCount: 1, rows: [{ intakeId, state, error: parameters[2] }] };
        }
        throw new Error(`unexpected SQL: ${statement}`);
      },
    );

    const claimed = await claimDiscovery(
      builderRequest("/api/platform/subplatforms/discover/claim"),
    );
    await expect(claimed.json()).resolves.toMatchObject({
      job: { id: intakeId, leaseId, discoverAttempts: 20 },
    });

    const failed = await failDiscovery(
      builderRequest("/api/platform/subplatforms/discover/fail", {
        intakeId,
        leaseId,
        error: "malicious archive rejected",
        retryable: true,
      }),
    );
    expect(failed.status).toBe(200);
    await expect(failed.json()).resolves.toMatchObject({ state: "rejected" });

    const reclaimed = await claimDiscovery(
      builderRequest("/api/platform/subplatforms/discover/claim"),
    );
    await expect(reclaimed.json()).resolves.toMatchObject({ job: null });
  });
});

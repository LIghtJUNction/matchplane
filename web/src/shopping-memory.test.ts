import { beforeEach, describe, expect, it, vi } from "vitest";

const { connect, poolQuery, release, transactionQuery } = vi.hoisted(() => ({
  connect: vi.fn(),
  poolQuery: vi.fn(),
  release: vi.fn(),
  transactionQuery: vi.fn(),
}));

vi.mock("./lib/auth", () => ({
  authDatabase: { connect, query: poolQuery },
}));

import {
  deleteShoppingMemory,
  parseShoppingMemoryMutation,
  readShoppingMemory,
  ShoppingMemoryValidationError,
  writeShoppingMemory,
} from "./shopping-memory";
import { shoppingMemoryIntent } from "./shopping-memory-contract";

beforeEach(() => {
  poolQuery.mockReset();
  transactionQuery.mockReset();
  release.mockReset();
  connect.mockReset();
  connect.mockResolvedValue({ query: transactionQuery, release });
});

describe("shopping memory", () => {
  it("accepts a bounded explicit profile and normalizes budget currency", () => {
    expect(
      parseShoppingMemoryMutation({
        enabled: true,
        expectedVersion: 0,
        facts: [
          { kind: "budget", key: "maximum", value: "5000", currency: "cny" },
          { kind: "purpose", key: "primary", value: " 日常通勤 " },
          { kind: "preference", key: "notes", value: "轻便、安静" },
          { kind: "exclusion", key: "notes", value: "不要皮革" },
        ],
      }),
    ).toEqual({
      enabled: true,
      expectedVersion: 0,
      facts: [
        { kind: "budget", key: "maximum", value: "5000", currency: "CNY" },
        { kind: "purpose", key: "primary", value: "日常通勤" },
        { kind: "preference", key: "notes", value: "轻便、安静" },
        { kind: "exclusion", key: "notes", value: "不要皮革" },
      ],
    });
  });

  it("rejects duplicates, invalid money, and oversized profiles", () => {
    expect(() =>
      parseShoppingMemoryMutation({
        enabled: true,
        expectedVersion: 0,
        facts: [
          { kind: "purpose", key: "primary", value: "通勤" },
          { kind: "purpose", key: "primary", value: "办公" },
        ],
      }),
    ).toThrow(ShoppingMemoryValidationError);
    expect(() =>
      parseShoppingMemoryMutation({
        enabled: true,
        expectedVersion: 0,
        facts: [{ kind: "budget", key: "maximum", value: "free" }],
      }),
    ).toThrow("预算必须是有效金额");
    expect(() =>
      parseShoppingMemoryMutation({
        enabled: false,
        expectedVersion: 0,
        facts: Array.from({ length: 17 }, (_, index) => ({
          kind: "preference",
          key: `field-${index}`,
          value: "value",
        })),
      }),
    ).toThrow("最多保存 16 条购物记忆");
  });

  it("uses enabled budget as a default but ignores disabled memory", () => {
    const facts = [
      {
        kind: "budget" as const,
        key: "maximum",
        value: "8800",
        currency: "CNY",
      },
    ];
    expect(
      shoppingMemoryIntent({
        enabled: true,
        facts,
        version: 1,
        updatedAt: "2026-08-22T00:00:00.000Z",
      }),
    ).toEqual({
      budget: { maximum: 8_800, currency: "CNY" },
      requirements: [],
    });
    expect(
      shoppingMemoryIntent({
        enabled: false,
        facts,
        version: 1,
        updatedAt: null,
      }),
    ).toEqual({ requirements: [] });
  });

  it("reads an empty profile without creating durable state", async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    await expect(
      readShoppingMemory(
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ),
    ).resolves.toEqual({
      enabled: true,
      facts: [],
      version: 0,
      updatedAt: null,
    });
  });

  it("writes an AI summary and a value-free audit record atomically", async () => {
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("RETURNING enabled"))
        return {
          rows: [
            {
              enabled: true,
              facts: [{ kind: "preference", key: "notes", value: "轻便" }],
              version: "2",
              updated_at: new Date("2026-08-22T08:00:00.000Z"),
            },
          ],
        };
      return { rows: [] };
    });
    const memory = await writeShoppingMemory({
      tenantId: "11111111-1111-4111-8111-111111111111",
      authUserId: "22222222-2222-4222-8222-222222222222",
      mutation: {
        enabled: true,
        expectedVersion: 1,
        facts: [{ kind: "preference", key: "notes", value: "轻便" }],
      },
      source: "conversation_summary",
    });

    expect(memory).toEqual({
      enabled: true,
      facts: [{ kind: "preference", key: "notes", value: "轻便" }],
      version: 2,
      updatedAt: "2026-08-22T08:00:00.000Z",
    });
    const auditCall = transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes("platform_audit_events"),
    );
    expect(JSON.stringify(auditCall?.[1])).not.toContain("轻便");
    expect(JSON.stringify(auditCall?.[1])).toContain("conversation_summary");
    expect(transactionQuery).toHaveBeenCalledWith("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });

  it("hard-deletes the profile and audits only metadata", async () => {
    transactionQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("DELETE FROM shopping_memory_profiles"))
        return {
          rows: [
            {
              enabled: true,
              facts: [{ kind: "purpose", key: "primary", value: "通勤" }],
              version: "3",
              updated_at: new Date("2026-08-22T08:00:00.000Z"),
            },
          ],
        };
      return { rows: [] };
    });
    await expect(
      deleteShoppingMemory({
        tenantId: "11111111-1111-4111-8111-111111111111",
        authUserId: "22222222-2222-4222-8222-222222222222",
      }),
    ).resolves.toEqual({
      enabled: true,
      facts: [],
      version: 0,
      updatedAt: null,
    });
    const auditCall = transactionQuery.mock.calls.find(([sql]) =>
      String(sql).includes("shopping.memory.deleted"),
    );
    expect(JSON.stringify(auditCall?.[1])).not.toContain("通勤");
    expect(release).toHaveBeenCalledOnce();
  });
});

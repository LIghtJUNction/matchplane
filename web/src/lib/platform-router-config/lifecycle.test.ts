import { describe, expect, it } from "vitest";
import type { ManagedPlatformRouterInput } from "./contract";
import { createManagedPlatformRouterLifecycle } from "./lifecycle";
import {
  credentialStorageEntry,
  type PlatformRouterStorageEntry,
  type ProtectedPlatformRouterStorage,
} from "./protected-storage";

const OLD_KEY_FILE =
  "platform-router-key-00000000-0000-4000-8000-000000000001.key";
const FIRST_DRAFT_ID = "00000000-0000-4000-8000-000000000002";
const SECOND_DRAFT_ID = "00000000-0000-4000-8000-000000000003";

class MemoryStorage implements ProtectedPlatformRouterStorage {
  readonly values = new Map<PlatformRouterStorageEntry, string>();
  private failure: {
    operation: "write" | "remove";
    entry: PlatformRouterStorageEntry;
  } | null = null;

  read(entry: PlatformRouterStorageEntry): string | null {
    return this.values.get(entry) ?? null;
  }

  write(
    entry: PlatformRouterStorageEntry,
    value: string,
    _label: string,
  ): void {
    this.maybeFail("write", entry);
    this.values.set(entry, value.trim());
  }

  remove(entry: PlatformRouterStorageEntry): void {
    this.maybeFail("remove", entry);
    this.values.delete(entry);
  }

  failOnce(
    operation: "write" | "remove",
    entry: PlatformRouterStorageEntry,
  ): void {
    this.failure = { operation, entry };
  }

  snapshot(): Array<[PlatformRouterStorageEntry, string]> {
    return [...this.values.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );
  }

  private maybeFail(
    operation: "write" | "remove",
    entry: PlatformRouterStorageEntry,
  ): void {
    if (
      this.failure?.operation === operation &&
      this.failure.entry === entry
    ) {
      this.failure = null;
      throw new Error(`simulated ${operation} failure for ${entry}`);
    }
  }
}

function input(overrides: Partial<ManagedPlatformRouterInput> = {}) {
  return {
    endpoint: "https://api.lmm.best/v1",
    model: "gpt-5.6-sol",
    protocol: "openai-compatible" as const,
    enabled: true,
    ...overrides,
  };
}

function createFixture() {
  const storage = new MemoryStorage();
  storage.write(
    "active-config",
    JSON.stringify({
      ...input({ model: "previous-model" }),
      credentialFile: OLD_KEY_FILE,
    }),
    "fixture",
  );
  storage.write(credentialStorageEntry(OLD_KEY_FILE), "active-key", "fixture");
  const ids = [FIRST_DRAFT_ID, SECOND_DRAFT_ID];
  const lifecycle = createManagedPlatformRouterLifecycle({
    storage,
    nextId: () => {
      const id = ids.shift();
      if (!id) throw new Error("fixture exhausted ids");
      return id;
    },
    now: () => new Date("2026-08-25T00:00:00.000Z"),
  });
  return { lifecycle, storage };
}

describe("managed platform router lifecycle", () => {
  it("rolls back every draft file and the new credential when staging fails", () => {
    const { lifecycle, storage } = createFixture();
    lifecycle.stage(input({ apiKey: "first-draft-key" }));
    lifecycle.markTested("request-before-failure");
    const before = storage.snapshot();

    storage.failOnce("write", "draft-metadata");

    expect(() =>
      lifecycle.stage(input({ model: "replacement-model", apiKey: "new-key" })),
    ).toThrow("simulated write failure");
    expect(storage.snapshot()).toEqual(before);
    expect(
      storage.read(
        credentialStorageEntry(
          `platform-router-key-${SECOND_DRAFT_ID}.key`,
        ),
      ),
    ).toBeNull();
    expect(lifecycle.getDraft()?.testedReady).toBe(true);
  });

  it("restores active and staged state when activation cleanup fails", () => {
    const { lifecycle, storage } = createFixture();
    lifecycle.stage(input({ apiKey: "replacement-key" }));
    lifecycle.markTested("request-ready-to-activate");
    const before = storage.snapshot();

    storage.failOnce("remove", "draft-metadata");

    expect(() => lifecycle.activate()).toThrow("simulated remove failure");
    expect(storage.snapshot()).toEqual(before);
    expect(lifecycle.getActive()?.model).toBe("previous-model");
    expect(lifecycle.getDraft()?.testedReady).toBe(true);
  });
});

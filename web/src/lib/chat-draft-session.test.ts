import { describe, expect, it } from "vitest";
import {
  CHAT_DRAFT_MAX_LENGTH,
  chatDraftSessionKey,
  clearChatDraft,
  readChatDraft,
  writeChatDraft,
  type ChatDraftScope,
  type ChatDraftStorage,
} from "./chat-draft-session";

const scope: ChatDraftScope = {
  route: "/",
  subplatform: "root",
  role: "buyer",
};

class MemoryStorage implements ChatDraftStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

describe("chat draft session storage", () => {
  it("restores the exact text that was written", () => {
    const storage = new MemoryStorage();
    const text = "  想找一件适合通勤的商品\n预算 800 元  ";

    writeChatDraft(storage, scope, text);

    expect(readChatDraft(storage, scope)).toBe(text);
  });

  it("safely ignores malformed and oversized stored data", () => {
    const storage = new MemoryStorage();
    const key = chatDraftSessionKey(scope);
    storage.setItem(key, "{not-json");
    expect(readChatDraft(storage, scope)).toBeNull();

    storage.setItem(
      key,
      JSON.stringify({
        version: 1,
        text: "x".repeat(CHAT_DRAFT_MAX_LENGTH + 1),
      }),
    );
    expect(readChatDraft(storage, scope)).toBeNull();

    writeChatDraft(storage, scope, "y".repeat(CHAT_DRAFT_MAX_LENGTH + 50));
    expect(readChatDraft(storage, scope)).toBe(
      "y".repeat(CHAT_DRAFT_MAX_LENGTH),
    );
  });

  it("isolates drafts by route, subplatform, and role", () => {
    const storage = new MemoryStorage();
    writeChatDraft(storage, scope, "只属于这个购买入口");

    expect(
      readChatDraft(storage, { ...scope, route: "/store/matx" }),
    ).toBeNull();
    expect(
      readChatDraft(storage, { ...scope, subplatform: "matx" }),
    ).toBeNull();
    expect(readChatDraft(storage, { ...scope, role: "seller" })).toBeNull();
    expect(readChatDraft(storage, scope)).toBe("只属于这个购买入口");
  });

  it("clears only the explicitly selected scope", () => {
    const storage = new MemoryStorage();
    const sellerScope = { ...scope, role: "seller" as const };
    writeChatDraft(storage, scope, "buyer draft");
    writeChatDraft(storage, sellerScope, "seller draft");

    clearChatDraft(storage, scope);

    expect(readChatDraft(storage, scope)).toBeNull();
    expect(readChatDraft(storage, sellerScope)).toBe("seller draft");
  });
});

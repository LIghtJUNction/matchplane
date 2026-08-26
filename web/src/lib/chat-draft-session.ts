export const CHAT_DRAFT_MAX_LENGTH = 10_000;

const CHAT_DRAFT_KEY_PREFIX = "matchplane.unsent-chat-draft.v1";
const CHAT_DRAFT_VERSION = 1;

export interface ChatDraftScope {
  route: string;
  subplatform: string;
  role: "buyer" | "seller";
}

export interface ChatDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface StoredChatDraft {
  version: typeof CHAT_DRAFT_VERSION;
  text: string;
}

export function chatDraftSessionKey(scope: ChatDraftScope): string {
  return [
    CHAT_DRAFT_KEY_PREFIX,
    encodeURIComponent(scope.route),
    encodeURIComponent(scope.subplatform),
    scope.role,
  ].join(":");
}

export function readChatDraft(
  storage: ChatDraftStorage,
  scope: ChatDraftScope,
): string | null {
  try {
    const raw = storage.getItem(chatDraftSessionKey(scope));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isStoredChatDraft(parsed)) return null;
    return parsed.text;
  } catch {
    return null;
  }
}

export function writeChatDraft(
  storage: ChatDraftStorage,
  scope: ChatDraftScope,
  text: string,
): void {
  if (!text.length) {
    clearChatDraft(storage, scope);
    return;
  }
  const draft: StoredChatDraft = {
    version: CHAT_DRAFT_VERSION,
    text: text.slice(0, CHAT_DRAFT_MAX_LENGTH),
  };
  try {
    storage.setItem(chatDraftSessionKey(scope), JSON.stringify(draft));
  } catch {
    // A blocked or full session store must never make the composer unusable.
  }
}

export function clearChatDraft(
  storage: ChatDraftStorage,
  scope: ChatDraftScope,
): void {
  try {
    storage.removeItem(chatDraftSessionKey(scope));
  } catch {
    // Treat storage as an optional continuity enhancement.
  }
}

function isStoredChatDraft(value: unknown): value is StoredChatDraft {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredChatDraft>;
  return (
    candidate.version === CHAT_DRAFT_VERSION &&
    typeof candidate.text === "string" &&
    candidate.text.length <= CHAT_DRAFT_MAX_LENGTH
  );
}

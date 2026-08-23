const MAX_CONVERSATIONS = 30;
const MAX_MESSAGES_PER_CONVERSATION = 80;

export interface ConversationHistoryRecord<Message> {
  id: string;
  title: string;
  updatedAt: string;
  messages: Message[];
}

interface ConversationHistoryEnvelope<Message> {
  owner: string;
  conversations: ConversationHistoryRecord<Message>[];
}

export function readConversationHistory<Message>(
  storage: Storage,
  key: string,
  owner: string,
  parseMessages: (value: unknown) => Message[],
): ConversationHistoryRecord<Message>[] {
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<
      ConversationHistoryEnvelope<unknown>
    >;
    if (parsed.owner !== owner || !Array.isArray(parsed.conversations))
      return [];
    return parsed.conversations.flatMap((candidate) => {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        typeof candidate.id !== "string" ||
        !candidate.id ||
        typeof candidate.title !== "string" ||
        typeof candidate.updatedAt !== "string"
      )
        return [];
      const messages = parseMessages(candidate.messages).slice(
        -MAX_MESSAGES_PER_CONVERSATION,
      );
      if (!messages.length) return [];
      return [
        {
          id: candidate.id,
          title: candidate.title,
          updatedAt: candidate.updatedAt,
          messages,
        },
      ];
    });
  } catch {
    return [];
  }
}

export function upsertConversationHistory<
  Message extends {
    role: "user" | "assistant";
    text: string;
  },
>({
  storage,
  key,
  owner,
  record,
  parseMessages,
}: {
  storage: Storage;
  key: string;
  owner: string;
  record: ConversationHistoryRecord<Message>;
  parseMessages: (value: unknown) => Message[];
}): ConversationHistoryRecord<Message>[] {
  const current = readConversationHistory(storage, key, owner, parseMessages);
  const messages = record.messages.slice(-MAX_MESSAGES_PER_CONVERSATION);
  if (!messages.length) return current;
  const next = [
    {
      ...record,
      title: conversationTitle(messages, record.title),
      messages,
    },
    ...current.filter((candidate) => candidate.id !== record.id),
  ]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_CONVERSATIONS);
  writeEnvelope(storage, key, owner, next);
  return next;
}

export function deleteConversationHistory<Message>({
  storage,
  key,
  owner,
  id,
  parseMessages,
}: {
  storage: Storage;
  key: string;
  owner: string;
  id: string;
  parseMessages: (value: unknown) => Message[];
}): ConversationHistoryRecord<Message>[] {
  const next = readConversationHistory(
    storage,
    key,
    owner,
    parseMessages,
  ).filter((candidate) => candidate.id !== id);
  writeEnvelope(storage, key, owner, next);
  return next;
}

export function conversationHistoryStorageKey(scopeKey: string): string {
  return scopeKey.replace(
    "matchplane.shopping-conversation.v1",
    "matchplane.shopping-conversation-history.v1",
  );
}

function conversationTitle(
  messages: Array<{ role: "user" | "assistant"; text: string }>,
  fallback: string,
): string {
  const firstUserMessage = messages.find(
    (message) => message.role === "user" && message.text.trim(),
  )?.text;
  if (!firstUserMessage) return fallback;
  const normalized = firstUserMessage.replace(/\s+/g, " ").trim();
  return normalized.length > 42
    ? `${normalized.slice(0, 42).trimEnd()}…`
    : normalized;
}

function writeEnvelope<Message>(
  storage: Storage,
  key: string,
  owner: string,
  conversations: ConversationHistoryRecord<Message>[],
) {
  try {
    storage.setItem(key, JSON.stringify({ owner, conversations }));
  } catch {
    // Storage can be unavailable or full; chat must remain usable without history.
  }
}

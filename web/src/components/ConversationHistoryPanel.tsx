"use client";

import { MessageSquarePlus, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@appica/ui-react/dialog";

import type { ConversationHistoryRecord } from "../lib/conversation-history";
import type { InterfaceLocale } from "../lib/preferences";

interface HistoryMessage {
  role: "user" | "assistant";
  text: string;
}

const copyByLocale = {
  en: {
    title: "Conversation history",
    description: "Saved only in this browser.",
    close: "Close history",
    newConversation: "New conversation",
    empty: "Start a conversation and it will appear here.",
    delete: (title: string) => `Delete ${title}`,
  },
  zh: {
    title: "历史对话",
    description: "仅保存在当前浏览器。",
    close: "关闭历史对话",
    newConversation: "新对话",
    empty: "开始对话后，会显示在这里。",
    delete: (title: string) => `删除${title}`,
  },
} as const;

function ConversationHistoryRow<Message extends HistoryMessage>({
  active,
  conversation,
  formatter,
  onDelete,
  onOpen,
  deleteLabel,
}: {
  active: boolean;
  conversation: ConversationHistoryRecord<Message>;
  formatter: Intl.DateTimeFormat;
  onDelete: (id: string) => void;
  onOpen: (conversation: ConversationHistoryRecord<Message>) => void;
  deleteLabel: string;
}) {
  const lastMessage = conversation.messages.at(-1)?.text ?? "";
  const updatedAt = new Date(conversation.updatedAt);
  const validDate = !Number.isNaN(updatedAt.getTime());

  return (
    <li className={active ? "is-active" : undefined}>
      <button
        className="conversation-history-open"
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={() => onOpen(conversation)}
      >
        <span className="conversation-history-copy">
          <strong>{conversation.title}</strong>
          <small>{lastMessage}</small>
        </span>
        {validDate ? (
          <time dateTime={conversation.updatedAt}>
            {formatter.format(updatedAt)}
          </time>
        ) : null}
      </button>
      <button
        className="conversation-history-delete"
        type="button"
        aria-label={deleteLabel}
        onClick={() => onDelete(conversation.id)}
      >
        <Trash2 aria-hidden="true" />
      </button>
    </li>
  );
}

export function ConversationHistoryPanel<Message extends HistoryMessage>({
  activeId,
  conversations,
  locale,
  onClose,
  onDelete,
  onOpen,
  onStartNew,
  open,
}: {
  activeId: string;
  conversations: ConversationHistoryRecord<Message>[];
  locale: InterfaceLocale;
  onClose: () => void;
  onDelete: (id: string) => void;
  onOpen: (conversation: ConversationHistoryRecord<Message>) => void;
  onStartNew: () => void;
  open: boolean;
}) {
  const copy = copyByLocale[locale === "en" ? "en" : "zh"];
  const formatter = new Intl.DateTimeFormat(locale === "en" ? "en" : "zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        className="conversation-history-dialog"
        closeLabel={copy.close}
        frame={false}
      >
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="conversation-history-body">
          <button
            className="conversation-history-new"
            type="button"
            onClick={onStartNew}
          >
            <MessageSquarePlus aria-hidden="true" />
            <span>{copy.newConversation}</span>
          </button>
          {conversations.length ? (
            <ul className="conversation-history-list">
              {conversations.map((conversation) => (
                <ConversationHistoryRow
                  active={conversation.id === activeId}
                  conversation={conversation}
                  deleteLabel={copy.delete(conversation.title)}
                  formatter={formatter}
                  key={conversation.id}
                  onDelete={onDelete}
                  onOpen={onOpen}
                />
              ))}
            </ul>
          ) : (
            <p className="conversation-history-empty">{copy.empty}</p>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

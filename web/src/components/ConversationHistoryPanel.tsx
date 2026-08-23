"use client";

import { useEffect, useRef } from "react";
import { MessageSquarePlus, Trash2 } from "lucide-react";
import { Button } from "@appica/ui-react/button";
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
    <li
      className={`grid min-w-0 grid-cols-[minmax(0,1fr)_44px] border-b border-border-overlay ${active ? "bg-background-muted shadow-[inset_2px_0_var(--foreground-intense)]" : ""}`}
    >
      <Button
        className="h-auto min-h-14 min-w-0 justify-between rounded-none px-3 py-2 text-start"
        variant="ghost"
        type="button"
        aria-current={active ? "page" : undefined}
        onClick={() => onOpen(conversation)}
      >
        <span className="grid min-w-0 gap-0.5">
          <strong className="truncate text-sm font-semibold">
            {conversation.title}
          </strong>
          <small className="truncate text-xs text-foreground-muted">
            {lastMessage}
          </small>
        </span>
        {validDate ? (
          <time
            className="shrink-0 text-xs text-foreground-muted tabular-nums"
            dateTime={conversation.updatedAt}
          >
            {formatter.format(updatedAt)}
          </time>
        ) : null}
      </Button>
      <Button
        className="size-[44px] rounded-none text-foreground-muted hover:text-destructive"
        variant="ghost"
        size="icon-sm"
        type="button"
        aria-label={deleteLabel}
        onClick={() => onDelete(conversation.id)}
      >
        <Trash2 aria-hidden="true" />
      </Button>
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
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    return () => {
      const previous = restoreFocusRef.current;
      restoreFocusRef.current = null;
      previous?.focus();
    };
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        className="conversation-history-dialog !max-h-[calc(100dvh-2rem)] !w-[calc(100vw-2rem)] !max-w-[36rem] overflow-hidden !rounded-2xl [&_[data-slot=dialog-close-button]]:!size-[44px]"
        closeLabel={copy.close}
        frame={false}
        viewportProps={{
          className: "max-sm:items-end max-sm:p-2",
        }}
      >
        <DialogHeader className="border-b border-border-overlay pe-18">
          <DialogTitle className="text-xl">{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="overflow-y-auto pb-6">
          <Button
            className="mb-4 min-h-[44px] w-full justify-center gap-2"
            variant="outline"
            type="button"
            onClick={onStartNew}
          >
            <MessageSquarePlus aria-hidden="true" />
            <span>{copy.newConversation}</span>
          </Button>
          {conversations.length ? (
            <ul className="m-0 list-none border-t border-border-overlay p-0">
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
            <p className="flex min-h-60 items-center justify-center px-6 text-center text-sm text-foreground-muted">
              {copy.empty}
            </p>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}

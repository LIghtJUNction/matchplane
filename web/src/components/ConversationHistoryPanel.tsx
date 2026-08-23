"use client";

import { History, MessageSquarePlus, Trash2 } from "lucide-react";

import type { ConversationHistoryRecord } from "../lib/conversation-history";
import type { InterfaceLocale } from "../lib/preferences";
import { WorkspaceSettingsDialog } from "./WorkspaceSettingsDialog";

interface HistoryMessage {
    role: "user" | "assistant";
    text: string;
}

function ConversationHistoryRow<Message extends HistoryMessage>({
    active,
    conversation,
    english,
    formatter,
    onDelete,
    onOpen,
}: {
    active: boolean;
    conversation: ConversationHistoryRecord<Message>;
    english: boolean;
    formatter: Intl.DateTimeFormat;
    onDelete: (id: string) => void;
    onOpen: (conversation: ConversationHistoryRecord<Message>) => void;
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
                aria-label={
                    english
                        ? `Delete ${conversation.title}`
                        : `删除${conversation.title}`
                }
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
    const english = locale === "en";
    const formatter = new Intl.DateTimeFormat(english ? "en" : "zh-CN", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });

    return (
        <WorkspaceSettingsDialog
            open={open}
            onClose={onClose}
            title={english ? "Conversation history" : "历史对话"}
            description={
                english
                    ? "Open conversations this browser saved."
                    : "打开当前浏览器保存的对话。"
            }
            closeLabel={english ? "Close history" : "关闭历史对话"}
            backdropLabel={
                english ? "Close conversation history" : "关闭历史对话窗口"
            }
            className="conversation-history-dialog"
        >
            <div className="conversation-history-panel">
                <button
                    className="conversation-history-new"
                    type="button"
                    onClick={onStartNew}
                >
                    <MessageSquarePlus aria-hidden="true" />
                    <span>{english ? "New conversation" : "新对话"}</span>
                </button>

                {conversations.length ? (
                    <ul className="conversation-history-list">
                        {conversations.map((conversation) => (
                            <ConversationHistoryRow
                                active={conversation.id === activeId}
                                conversation={conversation}
                                english={english}
                                formatter={formatter}
                                key={conversation.id}
                                onDelete={onDelete}
                                onOpen={onOpen}
                            />
                        ))}
                    </ul>
                ) : (
                    <div className="conversation-history-empty">
                        <History aria-hidden="true" />
                        <strong>
                            {english
                                ? "No saved conversations"
                                : "还没有历史对话"}
                        </strong>
                        <p>
                            {english
                                ? "This browser saves new conversations here."
                                : "当前浏览器会把新对话保存在这里。"}
                        </p>
                    </div>
                )}
            </div>
        </WorkspaceSettingsDialog>
    );
}

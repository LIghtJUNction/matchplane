import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { ConversationHistoryRecord } from "../lib/conversation-history";
import { ConversationHistoryPanel } from "./ConversationHistoryPanel";

interface Message {
  role: "user" | "assistant";
  text: string;
}

const conversation: ConversationHistoryRecord<Message> = {
  id: "conversation-1",
  title: "通勤车推荐",
  updatedAt: "2026-08-23T08:00:00.000Z",
  messages: [{ role: "user", text: "想找一台省油的通勤车" }],
};

function renderPanel({
  open = true,
  ...props
}: {
  open?: boolean;
  activeId?: string;
  conversations?: ConversationHistoryRecord<Message>[];
  onClose?: () => void;
  onDelete?: (id: string) => void;
  onOpen?: (conversation: ConversationHistoryRecord<Message>) => void;
  onStartNew?: () => void;
} = {}) {
  return (
    <ConversationHistoryPanel<Message>
      activeId={props.activeId ?? ""}
      conversations={props.conversations ?? []}
      locale="zh"
      onClose={props.onClose ?? vi.fn()}
      onDelete={props.onDelete ?? vi.fn()}
      onOpen={props.onOpen ?? vi.fn()}
      onStartNew={props.onStartNew ?? vi.fn()}
      open={open}
    />
  );
}

describe("ConversationHistoryPanel", () => {
  it("uses a compact utility dialog with one concise empty-state explanation", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onStartNew = vi.fn();
    render(renderPanel({ onClose, onStartNew }));

    const dialog = screen.getByRole("dialog", { name: "历史对话" });
    expect(dialog).toHaveClass("conversation-history-dialog");
    expect(dialog).not.toHaveClass("workspace-settings-dialog");
    expect(screen.getAllByText("仅保存在当前浏览器。")).toHaveLength(1);
    expect(screen.getByText("开始对话后，会显示在这里。")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "新对话" }));
    expect(onStartNew).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "关闭历史对话" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("opens and deletes populated conversations without conflating row actions", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const onOpen = vi.fn();
    render(
      renderPanel({
        activeId: conversation.id,
        conversations: [conversation],
        onDelete,
        onOpen,
      }),
    );

    const openButton = screen.getByRole("button", { name: /^通勤车推荐/ });
    expect(openButton).toHaveAttribute("aria-current", "page");
    await user.click(openButton);
    expect(onOpen).toHaveBeenCalledWith(conversation);

    await user.click(screen.getByRole("button", { name: "删除通勤车推荐" }));
    expect(onDelete).toHaveBeenCalledWith(conversation.id);
  });

  it("restores focus after the controlled dialog closes", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const view = render(
      <div>
        <button type="button">打开历史对话</button>
        {renderPanel({ open: false, onClose })}
      </div>,
    );
    const opener = screen.getByRole("button", { name: "打开历史对话" });
    opener.focus();

    view.rerender(
      <div>
        <button type="button">打开历史对话</button>
        {renderPanel({ onClose })}
      </div>,
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    view.rerender(
      <div>
        <button type="button">打开历史对话</button>
        {renderPanel({ open: false, onClose })}
      </div>,
    );
    expect(document.activeElement).toBe(opener);
  });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  deleteShoppingMemory: vi.fn(),
  getShoppingMemory: vi.fn(),
  reviseShoppingMemory: vi.fn(),
  saveShoppingMemory: vi.fn(),
}));
vi.mock("../api", () => api);

import { ShoppingMemoryPanel } from "./ShoppingMemoryPanel";

const memory = {
  enabled: true,
  facts: [
    { kind: "budget", key: "maximum", value: "5000", currency: "CNY" },
    { kind: "purpose", key: "primary", value: "日常通勤" },
    { kind: "preference", key: "notes", value: "轻便耐用" },
  ],
  version: 2,
  updatedAt: "2026-08-22T08:00:00.000Z",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  api.getShoppingMemory.mockResolvedValue(memory);
  api.saveShoppingMemory.mockResolvedValue({
    ...memory,
    enabled: false,
    version: 3,
  });
  api.reviseShoppingMemory.mockResolvedValue({
    memory: {
      ...memory,
      facts: [
        { kind: "budget", key: "maximum", value: "8000", currency: "CNY" },
        { kind: "purpose", key: "primary", value: "日常通勤" },
      ],
      version: 3,
    },
    message: "已将预算上限改为 8000 元，并保留通勤用途。",
  });
  api.deleteShoppingMemory.mockResolvedValue({
    enabled: true,
    facts: [],
    version: 0,
    updatedAt: null,
  });
});

describe("ShoppingMemoryPanel", () => {
  it("shows the AI summary instead of making the user fill a profile form", async () => {
    render(<ShoppingMemoryPanel open onClose={vi.fn()} locale="zh" />);

    expect(await screen.findByText("当前摘要")).toBeInTheDocument();
    expect(screen.getByText("日常通勤")).toBeInTheDocument();
    expect(screen.getByText("轻便耐用")).toBeInTheDocument();
    expect(screen.getByText("¥5,000.00")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("常用预算上限（人民币）"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        "自动记下长期购物需求；你可以随时查看、纠正、暂停或清空。",
      ),
    ).not.toBeInTheDocument();
  });

  it("lets the user tell AI how to revise memory and shows AI's reply", async () => {
    render(<ShoppingMemoryPanel open onClose={vi.fn()} locale="zh" />);
    await screen.findByText("当前摘要");
    fireEvent.click(screen.getByRole("button", { name: "修改记忆" }));

    fireEvent.change(screen.getByLabelText("说明要修改的内容"), {
      target: { value: "预算改成 8000 元，其他不变" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交修改" }));

    await waitFor(() =>
      expect(api.reviseShoppingMemory).toHaveBeenCalledWith({
        suggestion: "预算改成 8000 元，其他不变",
        expectedVersion: 2,
      }),
    );
    expect(
      await screen.findByText("已将预算上限改为 8000 元，并保留通勤用途。"),
    ).toBeInTheDocument();
    expect(screen.getByText("¥8,000.00")).toBeInTheDocument();
  });

  it("can pause automatic recall without deleting the visible summary", async () => {
    render(<ShoppingMemoryPanel open onClose={vi.fn()} locale="zh" />);
    await screen.findByText("当前摘要");

    fireEvent.click(screen.getByRole("switch", { name: "暂停" }));

    await waitFor(() =>
      expect(api.saveShoppingMemory).toHaveBeenCalledWith({
        enabled: false,
        facts: memory.facts,
        expectedVersion: 2,
      }),
    );
    expect(screen.getByText("日常通勤")).toBeInTheDocument();
  });

  it("requires a second action before deleting the whole AI summary", async () => {
    render(<ShoppingMemoryPanel open onClose={vi.fn()} locale="zh" />);
    await screen.findByText("当前摘要");
    fireEvent.click(screen.getByRole("button", { name: "数据管理" }));

    fireEvent.click(screen.getByRole("button", { name: "清空全部记忆" }));
    expect(api.deleteShoppingMemory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认清空" }));

    await waitFor(() =>
      expect(api.deleteShoppingMemory).toHaveBeenCalledOnce(),
    );
    expect(
      await screen.findByText("购物记忆已全部清空；后续对话可以重新形成摘要。"),
    ).toBeInTheDocument();
  });

  it("keeps retry available after a network error", async () => {
    api.getShoppingMemory.mockRejectedValue(new Error("网络暂时不可用"));
    render(<ShoppingMemoryPanel open onClose={vi.fn()} locale="zh" />);

    expect(await screen.findByText("网络暂时不可用")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeEnabled();
  });
});

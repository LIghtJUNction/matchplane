import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ProductTemplateConfig } from "../product-templates";
import { ProductTemplateSelector } from "./ProductTemplateSelector";

const templates: ProductTemplateConfig[] = [
  {
    id: "phone",
    label: "手机",
    description: "手机字段",
    category: "electronics.phone",
    supplyFields: [
      { key: "brand", label: "品牌", type: "text", required: true },
      { key: "model", label: "型号", type: "text", required: true },
      { key: "memory", label: "内存", type: "text" },
    ],
  },
  {
    id: "tablet",
    label: "平板",
    description: "平板字段",
    category: "electronics.tablet",
    supplyFields: [
      { key: "brand", label: "品牌", type: "text", required: true },
      { key: "model", label: "型号", type: "text", required: false },
      { key: "screen", label: "屏幕尺寸", type: "number", required: true },
    ],
  },
];

describe("ProductTemplateSelector", () => {
  it("keeps the current template and values when a switch is cancelled", () => {
    const onConfirm = vi.fn();
    render(
      <ProductTemplateSelector
        templates={templates}
        selectedTemplateId="phone"
        values={{ brand: "Acme", model: "One", memory: "256 GB" }}
        onConfirm={onConfirm}
        onRefresh={vi.fn()}
        locale="zh"
      />,
    );

    fireEvent.change(screen.getByLabelText("选择商品模板"), {
      target: { value: "tablet" },
    });
    expect(screen.getByText("保留共享字段").nextSibling).toHaveTextContent(
      "品牌",
    );
    expect(screen.getByText("清除原模板字段").nextSibling).toHaveTextContent(
      "内存、型号",
    );
    expect(screen.getByText("切换后待填写").nextSibling).toHaveTextContent(
      "屏幕尺寸",
    );

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText("手机字段")).toBeInTheDocument();
  });

  it("only preserves completely identical fields when a switch is confirmed", () => {
    const onConfirm = vi.fn();
    render(
      <ProductTemplateSelector
        templates={templates}
        selectedTemplateId="phone"
        values={{ brand: "Acme", model: "One", memory: "256 GB" }}
        onConfirm={onConfirm}
        onRefresh={vi.fn()}
        locale="zh"
      />,
    );

    fireEvent.change(screen.getByLabelText("选择商品模板"), {
      target: { value: "tablet" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确认切换" }));

    expect(onConfirm).toHaveBeenCalledWith({
      templateId: "tablet",
      category: "electronics.tablet",
      values: { brand: "Acme" },
    });
  });

  it("shows a compact explanation when only one template is enabled", () => {
    render(
      <ProductTemplateSelector
        templates={[templates[0]]}
        selectedTemplateId="phone"
        values={{}}
        onConfirm={vi.fn()}
        onRefresh={vi.fn()}
        locale="zh"
      />,
    );
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText("本店唯一启用模板")).toBeInTheDocument();
  });

  it("offers every enabled template as an explicit unresolved replacement", () => {
    const onConfirm = vi.fn();
    render(
      <ProductTemplateSelector
        templates={templates}
        selectedTemplateId="missing-template"
        values={{ brand: "Acme", private_code: "keep-out" }}
        onConfirm={onConfirm}
        onRefresh={vi.fn()}
        locale="zh"
        invalidReason="该商品绑定了当前目录中不存在的模板。"
      />,
    );

    const selector = screen.getByLabelText("选择商品模板");
    expect(selector).toHaveValue("");
    expect(screen.getByRole("option", { name: "手机" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "平板" })).toBeInTheDocument();

    fireEvent.change(selector, { target: { value: "phone" } });
    expect(screen.getByText("清除原模板字段").nextSibling).toHaveTextContent(
      "brand、private_code",
    );
    expect(screen.getByText("切换后待填写").nextSibling).toHaveTextContent(
      "品牌、型号",
    );
    fireEvent.click(screen.getByRole("button", { name: "确认切换" }));

    expect(onConfirm).toHaveBeenCalledWith({
      templateId: "phone",
      category: "electronics.phone",
      values: {},
    });
  });

  it("keeps one refresh button node and focus through loading and retry", () => {
    const onRefresh = vi.fn();
    const { rerender } = render(
      <ProductTemplateSelector
        templates={templates}
        selectedTemplateId="phone"
        values={{ brand: "Acme" }}
        onConfirm={vi.fn()}
        onRefresh={onRefresh}
        locale="zh"
      />,
    );

    const refresh = screen.getByRole("button", { name: "刷新模板设置" });
    refresh.focus();
    fireEvent.click(refresh);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    rerender(
      <ProductTemplateSelector
        templates={templates}
        selectedTemplateId="phone"
        values={{ brand: "Acme" }}
        onConfirm={vi.fn()}
        onRefresh={onRefresh}
        locale="zh"
        loading
      />,
    );
    expect(screen.getByRole("button", { name: "正在刷新模板…" })).toBe(refresh);
    expect(refresh).toBeDisabled();
    expect(refresh).toHaveAttribute("aria-busy", "true");

    rerender(
      <ProductTemplateSelector
        templates={templates}
        selectedTemplateId="phone"
        values={{ brand: "Acme" }}
        onConfirm={vi.fn()}
        onRefresh={onRefresh}
        locale="zh"
        error="网络暂时不可用"
      />,
    );
    const retry = screen.getByRole("button", { name: "重试加载模板" });
    expect(retry).toBe(refresh);
    expect(retry).toHaveFocus();
    fireEvent.click(retry);
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });
});

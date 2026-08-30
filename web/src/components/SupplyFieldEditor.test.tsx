import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { SupplyFieldConfig } from "../supply-fields";
import { SupplyFieldEditor } from "./SupplyFieldEditor";

const fields = [
  {
    key: 'vehicle.brand"]',
    label: "品牌",
    group: "基本信息",
    required: true,
    placeholder: "例如：奥迪",
  },
  {
    key: "mileage_km",
    label: "表显里程",
    type: "number",
    group: "基本信息",
    min: 0,
    max: 1_000_000,
    step: 1,
    unit: "公里",
    help: "请填写仪表显示的里程",
  },
  {
    key: "description",
    label: "补充说明",
    type: "textarea",
    help: "请勿填写联系方式",
  },
  {
    key: "source_url",
    label: "来源链接",
    type: "url",
    group: "发布资料",
  },
  {
    key: "registered_on",
    label: "上牌日期",
    type: "date",
    group: "发布资料",
  },
  {
    key: "transmission",
    label: "变速箱",
    type: "select",
    group: "发布资料",
    options: ["自动", "手动"],
    placeholder: "请选择变速箱",
  },
] satisfies readonly SupplyFieldConfig[];

describe("SupplyFieldEditor", () => {
  it("renders ordered semantic groups, native progress, and every control type", () => {
    const { container } = render(
      <SupplyFieldEditor
        fields={fields}
        values={{
          'vehicle.brand"]': "奥迪",
          description: "车况良好",
        }}
        onValueChange={vi.fn()}
        disabled={false}
        locale="zh"
      />,
    );

    expect(
      screen
        .getAllByRole("group")
        .map((group) => group.querySelector("legend")?.textContent),
    ).toEqual(["基本信息", "补充资料", "发布资料"]);
    expect(
      within(screen.getByRole("group", { name: "基本信息" })).getByText(
        "已填写 1 / 2",
      ),
    ).toBeInTheDocument();

    const progress = screen.getByRole("progressbar", { name: "总完成度" });
    expect(progress).toHaveAttribute("max", "6");
    expect(progress).toHaveAttribute("value", "2");
    expect(screen.getByText("已填写 2 / 6")).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "基本信息完成度" }),
    ).toHaveAttribute("value", "1");

    const brand = screen.getByLabelText("品牌");
    expect(brand).toHaveAttribute("type", "text");
    expect(brand).toBeRequired();
    expect(brand).toHaveAttribute("placeholder", "例如：奥迪");
    expect(brand.id).not.toContain('vehicle.brand"]');

    const mileage = screen.getByLabelText("表显里程");
    expect(mileage).toHaveAttribute("type", "number");
    expect(mileage).toHaveAttribute("min", "0");
    expect(mileage).toHaveAttribute("max", "1000000");
    expect(mileage).toHaveAttribute("step", "1");
    expect(mileage).toHaveAccessibleDescription("请填写仪表显示的里程 公里");

    expect(screen.getByLabelText("来源链接")).toHaveAttribute("type", "url");
    expect(screen.getByLabelText("上牌日期")).toHaveAttribute("type", "date");
    expect(screen.getByLabelText("变速箱")).toHaveValue("");
    expect(
      within(screen.getByLabelText("变速箱"))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["请选择变速箱", "自动", "手动"]);

    const textarea = screen.getByLabelText("补充说明");
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(textarea.closest(".supply-field-control")).toHaveClass("is-wide");
    expect(container.querySelector(".supply-field-editor")).toBeInTheDocument();
  });

  it("emits key/value changes and honors the disabled state", async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    const view = render(
      <SupplyFieldEditor
        fields={fields}
        values={{}}
        onValueChange={onValueChange}
        disabled={false}
        locale="zh"
      />,
    );

    fireEvent.change(screen.getByLabelText("品牌"), {
      target: { value: "宝马" },
    });
    expect(onValueChange).toHaveBeenCalledWith('vehicle.brand"]', "宝马");

    view.rerender(
      <SupplyFieldEditor
        fields={fields}
        values={{}}
        onValueChange={onValueChange}
        disabled
        locale="zh"
      />,
    );
    await user.click(screen.getByLabelText("变速箱"));
    expect(screen.getByLabelText("变速箱")).toBeDisabled();
    expect(onValueChange).toHaveBeenCalledTimes(1);
  });

  it("localizes only editor-owned fallback and progress copy", () => {
    render(
      <SupplyFieldEditor
        fields={[{ key: "trim", label: "Trim level" }]}
        values={{ trim: "Sport" }}
        onValueChange={vi.fn()}
        disabled={false}
        locale="en"
      />,
    );

    expect(
      screen.getByRole("group", { name: /Additional details/ }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("1 of 1 completed")).toHaveLength(2);
    expect(screen.getByLabelText("Trim level")).toHaveValue("Sport");
  });

  it("renders nothing for an empty declaration", () => {
    const { container } = render(
      <SupplyFieldEditor
        fields={[]}
        values={{}}
        onValueChange={vi.fn()}
        disabled={false}
        locale="zh"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

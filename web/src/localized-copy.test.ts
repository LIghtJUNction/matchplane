import { describe, expect, it } from "vitest";

import { localizedSubplatformCopy } from "./lib/localized-copy";
import type { SubplatformConfig } from "./subplatform";

const subplatform: SubplatformConfig = {
  slug: "root",
  path: "/",
  brandName: "MatchPlane",
  label: "通用撮合",
  description: "描述你的目标",
  ui: { copy: { greeting: "你好", greetingEn: "Hello" } },
};

describe("localized subplatform copy", () => {
  it("uses the package's locale-specific override when available", () => {
    expect(localizedSubplatformCopy(subplatform, "en", "greeting", "你好", "Hello there")).toBe("Hello");
    expect(localizedSubplatformCopy(subplatform, "zh", "greeting", "你好", "Hello there")).toBe("你好");
  });

  it("falls back to the root translation without inventing package fields", () => {
    expect(localizedSubplatformCopy(subplatform, "en", "missing", "中文", "English")).toBe("English");
    expect(localizedSubplatformCopy(subplatform, "zh", "missing", "中文", "English")).toBe("中文");
  });
});

---
name: "matchplane-ink-and-paper"
colors:
  background: "--retail-canvas"
  surface: "--retail-surface"
  text: "--retail-ink"
  primary: "--retail-accent"
  primaryForeground: "--retail-accent-contrast"
---

# Design System: MatchPlane Ink & Paper

## Visual Theme & Atmosphere

- [confirmed] 默认世界是墨黑与暖白：纸张感背景、炭黑文字、克制边界和真实商品摄影。
- [confirmed] ChatGPT 与 Anthropic 只是用户指定的色调类比；不得复制其 Logo、字标、聊天布局、图标或品牌资产。
- [confirmed] 商品、店铺和真实状态是视觉主角。界面不得回到科技蓝、大面积冷灰、工业档案感、海报巨字或等高三栏。
- [confirmed] 色彩是用户偏好，不是品牌噪声。默认 `ink` 必须完整可用，其他 palette 只改变动作色和相关状态层。
- [confirmed] 禁用玻璃拟态、装饰渐变、卡片套卡片、无语义胶囊和用于填充版面的装饰物。

## Color Palette & Roles

- [observed] Ink light：画布 `#f3f0e9`、表面 `#fffdf8`、文字 `#171715`、柔和表面 `#ece9e1`。
- [observed] Ink dark：画布 `#171715`、表面 `#22211e`、文字 `#f4f1e8`、柔和表面 `#2c2a26`。
- [confirmed] 默认主要动作使用墨黑与暖白反差，不使用科技蓝。
- [confirmed] 调色盘提供 5 个经过对比度约束的方案：`ink`、`moss`、`clay`、`plum`、`amber`。不提供可破坏可读性的任意色输入。
- [confirmed] 明暗主题与 palette 相互独立：主题切换表面亮度，palette 切换动作色。
- [confirmed] 成功、警告、失败状态同时使用文字或图标，不只依赖颜色。

## Typography Rules

- [confirmed] 标题使用现代系统无衬线，紧凑字距和正常字宽；眉题可使用窄体等宽字强化编辑感。
- [confirmed] 首页标题桌面不超过约 3.55rem，移动端约 2.35rem；不得挤掉商品或真实状态。
- [confirmed] 商品名、价格、店铺和恢复动作优先可扫读。极长价格允许换行，不得溢出卡片。
- [confirmed] 界面文案直接说明动作和结果，避免步骤式铺垫句和口号收尾。

## Layout Principles

- [confirmed] 公开商城使用全宽轻顶栏和无卡片 Hero，以一条边界进入商品区域。
- [confirmed] 4 个及以上商品使用图片优先网格；0–2 个商品进入稀疏布局，让商品与店铺目录并列，避免长画布孤岛。
- [confirmed] 872px 左右仍应保持有效双栏；48rem 以下改为单栏。移动商品区不得横向溢出。
- [confirmed] Clerk 不参与文档排版。桌面以 `document.body` 下的固定视口 Portal 为锚点，移动端使用底部 Drawer。
- [confirmed] 设置、登录、商家和运营页面沿用相同颜色、边界、按钮和表单语法；密集数据使用列表或表格。

## Component Styling

- [confirmed] `PalettePicker` 使用 Appica/Base UI `Popover` 和 `ColorSwatchPicker`；选择写入 `matchplane.palette` 并在 hydration 前恢复。
- [confirmed] 桌面 `FloatingMarketplaceClerk` 使用 `react-rnd` 处理拖动、缩放和边界；Appica `Collapsible` 处理收纳。
- [confirmed] 移动 Clerk 使用 Appica/Base UI `Drawer`，支持关闭、Escape 与手势；不得手写拖拽或浮层底层逻辑。
- [confirmed] 商品卡以真实媒体、店铺、名称、价格和明确查看动作为核心；边界轻，媒体比例稳定。
- [confirmed] Button 至少 44px 高。主要动作使用当前 accent 与 `--retail-accent-contrast`，次要动作使用纸面和边界。
- [confirmed] Badge 只表达状态或数量，Tag 只表达筛选。普通说明文字不得包进胶囊。
- [confirmed] 空态、加载和失败属于商品区域，必须陈述事实并提供可执行动作。
- [confirmed] AI 回答失败时保留原问题，并提供文案明确的“重试回答”操作。

## Clerk Interaction

- [confirmed] 关闭时只显示视口安全区内的单一入口；入口不随文档滚动漂移。
- [confirmed] 桌面打开后默认停靠右下安全区，标题栏可拖动，窗口可缩放，边缘受固定视口 Portal 约束。
- [confirmed] 收纳保留标题条和对话状态，用户可以拖动标题条或展开继续。
- [confirmed] 桌面浮窗不添加整屏遮罩，不阻断商品浏览。移动 Drawer 可以使用命名遮罩。
- [confirmed] 视口跨过移动断点时允许容器重建；聊天数据和服务端会话契约不得改变。

## Motion & Interaction

- [confirmed] 精确指针 hover 只允许商品卡轻微上移、图片极小缩放和图标短距离位移。
- [confirmed] 浮窗出现、收纳和 Popover 使用短时淡入或位移；拖动与缩放由成熟库直接响应指针。
- [confirmed] `prefers-reduced-motion` 下移除位移、缩放、面板和骨架动画，不影响状态变化。

## Accessibility

- [confirmed] 主要交互目标至少 44×44px，键盘焦点清晰且不被裁切。
- [confirmed] 调色盘使用 listbox/option 语义并提供中英文色名；当前选择通过 `aria-selected` 暴露。
- [confirmed] Clerk 入口暴露 `aria-expanded` 和面板关系；关闭状态不得把输入留在可访问树中。
- [confirmed] 桌面收纳、展开和关闭按钮具备明确名称；移动 Drawer 提供 Title、Description 和 Close。
- [confirmed] 商品图片使用商品名作为替代文本，纯装饰图标隐藏于辅助技术。
- [confirmed] 320px 宽度下关键内容、调色盘、登录、商品动作和失败恢复均可达。

## Source Evidence & Confidence

- [observed] path: `web/src/retail-ui.css`
  sha256: `1de25b5f519a288f0f8ca133c07eb7cacd56a7a355eb569e0615da866e5600ed`
  confidence: high
- [observed] path: `web/src/components/MarketplaceHome.tsx`
  sha256: `fec369411ab91cd9b7be09a18b7579d902537103133281c7cc13f7fca06bcae6`
  confidence: high
- [observed] path: `web/src/components/FloatingMarketplaceClerk.tsx`
  sha256: `b1343d2461eee7884bb07aa980b17d7265eb1a51d522517fa946f7a6b9514c2a`
  confidence: high
- [observed] path: `web/src/components/PalettePicker.tsx`
  sha256: `e69cce67133de51ff5b6d573a288190aa6f71592628a9a47b0c143b27f61c50c`
  confidence: high
- [observed] path: `web/src/lib/preferences.ts`
  sha256: `589d4a2d275c6149d276eed8714004a9f12d202e637b5daf401625661a03d6a2`
  confidence: high
- [observed] path: `web/src/App.tsx`
  sha256: `3b7e83a9effb2659964d9aad261772cb88bb002f83e1cd86157e1ed52a5b4388`
  confidence: high
- [observed] path: `web/public/theme-init.js`
  sha256: `952e1cbd31e994fb6e624aac8669450eab8f06b3968be874e43bc9e5b269edd2`
  confidence: high

## Known Gaps & Exceptions

- [confirmed] 第三方 subplatform 可保留自己的品牌色；挂载壳、焦点、状态反馈和触摸目标仍遵循本基线。
- [confirmed] 运营表格允许横向滚动，不得通过缩小到不可读字号适配移动端。
- [inferred confidence=medium] 浏览器跨断点时桌面 Rnd 与移动 Drawer 会重建视图；该行为不应清除服务端对话历史，但未承诺保留未发送草稿。

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
- [confirmed] ChatGPT 与 Anthropic 只是用户指定的色调类比；不得复制其 Logo、字标、聊天布局、图标、文案、图片、按钮几何或品牌资产。
- [confirmed] 商品、店铺、真实状态和用户当前任务是视觉主角。界面不得回到科技蓝、大面积冷灰、工业档案感、海报巨字或等高三栏。
- [confirmed] 色彩是用户偏好，不是品牌噪声。默认 `ink` 必须完整可用，其他 palette 只改变动作色和相关状态层。
- [confirmed] 禁用玻璃拟态、装饰渐变、卡片套卡片、无语义胶囊、假数据地图和用于填充版面的装饰物。

## Color Palette & Roles

- [observed] Ink light：画布 `#f3f0e9`、表面 `#fffdf8`、文字 `#171715`、柔和表面 `#ece9e1`。
- [observed] Ink dark：画布 `#171715`、表面 `#22211e`、文字 `#f4f1e8`、柔和表面 `#2c2a26`。
- [confirmed] 默认主要动作使用墨黑与暖白反差，不使用科技蓝。
- [confirmed] 调色盘提供 5 个经过对比度约束的方案：`ink`、`moss`、`clay`、`plum`、`amber`。不提供可破坏可读性的任意色输入。
- [confirmed] 明暗主题与 palette 相互独立：主题切换表面亮度，palette 切换动作色。
- [confirmed] 成功、警告、失败状态同时使用文字或图标，不只依赖颜色。

## Typography Rules

- [confirmed] 标题使用现代系统无衬线，紧凑字距和正常字宽；眉题可使用窄体等宽字强化编辑感。
- [confirmed] 首页标题桌面不超过约 3.55rem，移动端约 2.35rem；不得挤掉主要任务、商品或真实状态。
- [confirmed] 商品名、价格、店铺和恢复动作优先可扫读。极长价格允许换行，不得溢出卡片。
- [confirmed] 界面文案直接说明动作和结果，避免步骤式铺垫句、抽象口号和结论重复。

## Layout Principles

- [confirmed] 公开根商城使用全宽轻顶栏和无卡片入口；第一视口先完成一项真实任务，再渐进展示目录与平台能力。
- [confirmed] 根商城在首次互动前保持低密度；提交需求后，允许沿同一阅读轴增加对话、检索路径和商品结果，不弹出第二套主界面。
- [confirmed] 4 个及以上商品使用图片优先网格；0–2 个商品进入稀疏布局，让商品与店铺目录并列，避免长画布孤岛。
- [confirmed] 872px 左右仍应保持有效双栏；48rem 以下改为单栏。移动商品区和检索路径不得造成页面横向溢出。
- [confirmed] 设置、登录、商家和运营页面沿用相同颜色、边界、按钮和表单语法；密集数据使用列表或表格。

## Progressive Marketplace Entrance

- [confirmed] 根商城第一视口的唯一主行动是内联购物对话输入；目录、示例和状态只能作为支持证据，不得与输入争抢权重。
- [confirmed] 根商城不同时显示浮动导购。第一条对话、后续澄清与结果都在同一个内联会话中连续发生。
- [confirmed] “检索路径 / 结果来源”只由当前响应中真实可见推荐的店铺路径与名称生成；没有真实结果时不绘制店铺节点、连接线或数量。
- [confirmed] 路径只说明 `用户需求 → MatchPlane → 实际结果店铺 → 商品`，不得冒充完整模型推理、全部候选、授权链或递归平台拓扑。
- [confirmed] 首次互动后的密度增长必须是内容驱动：回答、实际店铺和商品出现才占用空间；加载态不得以假 skeleton 节点预演不存在的路由。
- [confirmed] 移动端把路径转换为纵向语义列表；连接线只是辅助视觉，不承载唯一顺序或状态信息。
- [confirmed] canonical store path 只来自 active registry/manifest/API；根核心、默认基础设施和 UI 不得包含任何真实部署实例的 slug 或 path。

## Component Styling

- [confirmed] `PalettePicker` 使用 Appica/Base UI `Popover`、`RadioGroup` 与 `Radio` 多色主题卡；选择写入 `matchplane.palette` 并在 hydration 前恢复。
- [confirmed] 桌面 `FloatingMarketplaceClerk` 使用 Appica/Base UI `Dialog` 与成熟的 Rnd 实现固定视口浮窗；只服务非 root 子平台，不添加整屏遮罩。
- [confirmed] 移动 Clerk 使用 Appica/Base UI `Drawer`，支持关闭、Escape 与手势；不得手写拖拽或浮层底层逻辑。
- [confirmed] 商品卡以真实媒体、店铺、名称、价格和明确查看动作为核心；边界轻，媒体比例稳定。
- [confirmed] Button 至少 44px 高。主要动作使用当前 accent 与 `--retail-accent-contrast`，次要动作使用纸面和边界。
- [confirmed] Badge 只表达状态或数量，Tag 只表达筛选。普通说明文字不得包进胶囊。
- [confirmed] 空态、加载和失败属于它们触发的任务区域，必须陈述事实并提供可执行动作。
- [confirmed] AI 回答失败时保留原问题，并提供文案明确的“重试回答”操作。

## Clerk Interaction

- [confirmed] 关闭时只显示视口安全区内的单一入口；入口不随文档滚动漂移。
- [confirmed] 桌面打开后默认停靠右下安全区，标题栏可拖动，窗口可缩放，边缘受固定视口 Portal 约束。
- [confirmed] 收纳保留标题条和对话状态，用户可以拖动标题条或展开继续。
- [confirmed] 桌面浮窗不添加整屏遮罩，不阻断商品浏览。移动 Drawer 可以使用命名遮罩。
- [confirmed] 视口跨过移动断点时允许容器重建；聊天数据和服务端会话契约不得改变。

## Motion & Interaction

- [confirmed] 精确指针 hover 只允许商品卡轻微上移、图片极小缩放和图标短距离位移。
- [confirmed] 渐进展开、浮窗出现、收纳和 Popover 使用短时 opacity/transform 过渡；动效必须可被用户滚动、输入和点击打断。
- [confirmed] 不使用滚动劫持、自动循环、视差叙事或依赖动画才能理解的状态。
- [confirmed] `prefers-reduced-motion` 下移除位移、缩放、面板和骨架动画，状态立即完成且信息不丢失。

## Accessibility

- [confirmed] 主要交互目标至少 44×44px，键盘焦点清晰且不被裁切。
- [confirmed] 调色盘使用 listbox/option 语义并提供中英文色名；当前选择通过 `aria-selected` 暴露。
- [confirmed] Clerk 入口暴露 `aria-expanded` 和面板关系；关闭状态不得把输入留在可访问树中。
- [confirmed] 检索路径的店铺节点使用 Link/Button 语义并包含店名与真实商品数；纯视觉连接线对辅助技术隐藏。
- [confirmed] 商品图片使用商品名作为替代文本，纯装饰图标隐藏于辅助技术。
- [confirmed] 320px 宽度下关键内容、对话输入、检索路径、调色盘、登录、商品动作和失败恢复均可达。

## Source Evidence & Confidence

- [observed] path: `PRODUCT.md`
  sha256: `18c7b613d1470429eee568e9e6e79d997c2e98f36f2199c3d753449d3eafdb23`
  confidence: high
- [observed] path: `web/src/components/PalettePicker.tsx`
  sha256: `2998f459fbf8d2a4e840030020125b6d4a176a3a20b6d7e2a7a4a8c1a65d48bc`
  confidence: high
- [observed] path: `web/src/lib/preferences.ts`
  sha256: `f32fea4c01282d96544d3692d44336ccfcc8c610566f32219eda1782f418cb91`
  confidence: high
- [observed] path: `web/public/theme-init.js`
  sha256: `79bc80eab49b1fef084f75540f608121a6578c5c72b0d3bf86485de097502970`
  confidence: high
- [observed] path: `web/src/components/MarketplaceHome.tsx`
  sha256: `83d75d15efae11321b7f557b1feffcaec2c438fe1c6f8a9d43cb39fbc03153dc`
  confidence: high
- [observed] path: `web/src/components/MarketplaceSearchTrace.tsx`
  sha256: `ecba4c6ed6181b051a8e3927c3e8b23b130234a8401df661ee05ea0f52c38fb1`
  confidence: high
- [observed] path: `web/src/components/MatchChat.tsx`
  sha256: `aabfe376849185a4f52e2814cd1b88d71fed9fc6485e9f9cda90a31d8419199c`
  confidence: high
- [observed] path: `web/src/platform-router.ts`
  sha256: `7f4db1c78aacebb1a00164ecaa587cf00269691920b3b7078c140829269fc894`
  confidence: high
- [observed] path: `web/src/retail-ui.css`
  sha256: `d13df480447b6957cfe939acce26f19c571d45d03f5612bd2994cf858f44a343`
  confidence: high
- [observed] path: `web/src/App.tsx`
  sha256: `462072447d1da79539b94c4f8f33729e5e60829e0988d8a2fb2682cd984a698e`
  confidence: high

## Known Gaps & Exceptions

- [confirmed] 第三方 subplatform 可保留自己的品牌色；挂载壳、焦点、状态反馈和触摸目标仍遵循本基线。
- [confirmed] 运营表格允许横向滚动，不得通过缩小到不可读字号适配移动端。
- [inferred confidence=medium] 浏览器跨断点时桌面 Rnd 与移动 Drawer 会重建视图；该行为不应清除服务端对话历史，但未承诺保留未发送草稿。
- [inferred confidence=medium] 根商城当前只能可靠公开“返回结果来自哪些店铺”，不能声称公开了完整路由决策；若协议未来提供可审计 route trace，需重新进入设计成形再扩展可视化。

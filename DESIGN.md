---
name: "matchplane-contemporary-store"
colors:
  background: "--background"
  surface: "--surface"
  text: "--foreground"
  primary: "--primary"
  accent: "--retail-blue"
---

# Design System: MatchPlane Contemporary Store

## Visual Theme & Atmosphere

- [confirmed] 全站采用“当代选品店”方向：冷白或柔灰背景、清晰商品摄影、克制蓝色动作和低噪声信息层级。
- [confirmed] 商品、店铺和真实状态是视觉主角；品牌框架保持轻量，不使用大面积纯黑、工业档案感、海报巨字或等高三栏。
- [confirmed] 公开商城、店铺、登录、设置、商家后台和运营后台属于同一套产品界面。公开面强调浏览，工具面强调效率。
- [confirmed] 禁用玻璃拟态、装饰渐变、卡片套卡片、无语义胶囊和用于填充版面的装饰物。

## Color Palette & Roles

- [observed] 页面底色：`--background: #f5f7f9`，承载公开商城和工具壳。
- [observed] 内容表面：`--surface: #ffffff`，用于 Hero、表单、Dialog 和必要的状态面板。
- [observed] 主文字：`--foreground: #1b1d21`；次要文字使用 `--muted`，不得依赖低对比灰传达关键状态。
- [observed] 动作蓝：`--primary` / `--retail-blue`，用于主要按钮、焦点和明确链接，不铺满大块背景。
- [confirmed] 暗色主题使用炭灰背景和分层表面，不把页面、卡片、导航和遮罩涂成同一黑色。
- [confirmed] 成功、警告、失败状态同时使用文字或图标，不只依赖颜色。

## Typography Rules

- [confirmed] 标题使用现代系统无衬线，紧凑字距和正常字宽；商品名、价格与状态优先可扫读。
- [confirmed] 首页标题在桌面保持约 3.5rem 上限，移动端约 2.35rem；不得挤掉首屏商品或状态。
- [confirmed] 眉题只用于来源或区段定位，使用小号蓝色字，不制造海报式视觉噪声。
- [confirmed] 界面文案直接说明动作和结果，避免步骤式铺垫句和口号收尾。

## Layout Principles

- [confirmed] 公开商城使用全宽轻顶栏，不设置左侧 Rail。内容由 Hero、商品 Stage、店铺目录自然纵向展开。
- [confirmed] 商品 Stage 桌面最多四列，中等宽度三列，移动端两列；图片面积必须大于商品元信息面积。
- [confirmed] Clerk 是唯一对话输入区。公开商城默认只显示右下角入口，展开后使用右侧浮层；移动端使用可关闭的底部面板。
- [confirmed] Hero 说明页面目的并承载关键入口，但不得占据整个首屏。真实商品、加载、失败或空态应在首屏范围内出现。
- [confirmed] 设置、商家和运营页面沿用相同颜色、边框、按钮与表单语法；密集数据使用列表或表格，不堆叠仪表盘卡片。
- [confirmed] 登录桌面采用双面板构图，移动端保留完整表单并移除非必要装饰面。

## Component Styling

- [confirmed] 商品卡以无外框或极轻边界呈现：真实媒体、店铺、名称、价格和明确查看动作。图片使用稳定比例和小半径圆角。
- [confirmed] Button 保持清晰边界和至少 44px 触摸高度。主要动作使用蓝底，次要动作使用白色或透明表面。
- [confirmed] Badge 只表达状态或数量，Tag 只表达筛选。普通说明文字不得包进胶囊。
- [confirmed] 空态、加载和失败属于商品区域，必须陈述事实并提供可执行动作；失败不得破坏网格或在窄屏形成竖排文字。
- [confirmed] 表单标签常驻，placeholder 仅作示例。错误紧邻控件，提交中保留用户输入和动作上下文。
- [confirmed] AI 回答失败时保留原问题，说明失败，并提供文案明确的“重试回答”操作。

## Motion & Interaction

- [confirmed] 精确指针 hover 只允许商品卡轻微上移、图片极小缩放和图标短距离位移。
- [confirmed] Clerk 展开与关闭使用短时淡入和位移，动画可被用户操作打断。
- [confirmed] `prefers-reduced-motion` 下移除位移、缩放、面板和骨架动画，不影响状态变化。

## Accessibility

- [confirmed] 所有主要交互目标至少 44×44px，键盘焦点清晰且不被裁切。
- [confirmed] 商品图片使用商品名作为替代文本，纯装饰图标隐藏于辅助技术。
- [confirmed] Clerk 入口暴露 `aria-expanded` 和面板关系；关闭后隐藏的输入框不能留在可访问树中。
- [confirmed] Dialog 和浮层恢复焦点，移动 Clerk 支持关闭按钮、命名遮罩与 Escape。
- [confirmed] 320px 宽度下关键内容、登录、商品动作和失败恢复均可达。

## Source Evidence & Confidence

- [observed] path: `web/src/retail-ui.css`
  sha256: `12379ff8bfd6df9bfd18a1b6e357d9792249d1b396fbc721bc14ccaa88cfac2e`
  confidence: high
- [observed] path: `web/src/components/MarketplaceHome.tsx`
  sha256: `973101ac0f1c9c58ee686d208e0c9379212c54cbf5bf16b6e601a1708ba2eafd`
  confidence: high
- [observed] path: `web/src/components/MarketplaceListingCard.tsx`
  sha256: `412bcab6153b268a6390a028b46d4ba7dae0a543130d842ee6056cb12331bd10`
  confidence: high
- [observed] path: `web/src/App.tsx`
  sha256: `4671781821d2e05a1238ea028e2c78b1702e7866fc300b2e31f64a680e6c0aa0`
  confidence: high
- [observed] path: `web/src/components/MatchChat.tsx`
  sha256: `af91fa6232cca5b912566fcce745070c8153a61460773cce100973be7ffabd35`
  confidence: high
- [observed] path: `web/app/layout.tsx`
  sha256: `c87edd1df5740c7788a23c789a9c1c5bd65f2d81d09eed9d1febc5dc81863ab4`
  confidence: high

## Known Gaps & Exceptions

- [confirmed] 第三方 subplatform 可保留自己的品牌色；挂载壳、焦点、状态反馈和触摸目标仍遵循本基线。
- [confirmed] 运营表格允许横向滚动，不得通过缩小到不可读字号适配移动端。
- [inferred confidence=medium] 生产目录可能为空；商品网格已用受控图片数据验证，仍需在真实商品上线后持续抽查图片比例与裁切。

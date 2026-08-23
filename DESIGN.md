---
name: "matchplane-archive-wall"
colors:
  background: "--background"
  surface: "--surface"
  text: "--foreground"
  primary: "--primary"
  accent: "--archive-orange"
---

# Design System: MatchPlane Archive Wall

## Visual Theme & Atmosphere

- [confirmed] 全站采用“球鞋档案墙”的跨品类转译：档案盒、纸板、纸巾内衬、油墨字和色签。不得复制鞋类品牌、鞋盒商标或潮牌装饰。
- [confirmed] 商品图片和真实数据是主角；档案盒只负责组织和操作暗示。
- [confirmed] 公开商城、店铺、登录、设置、商家后台和商城运营后台属于同一视觉世界。公开面疏朗，工具面紧凑。
- [confirmed] 禁用玻璃拟态、装饰渐变、大面积柔光、卡片套卡片和无语义胶囊。

## Color Palette & Roles

- [observed] 油墨：`--ink: #11100e`，用于主文字、轨道、关键边框和主要动作。
- [observed] 纸巾白：`--archive-tissue: #fffdf7`，用于商品端标、表单和内容工作面。
- [observed] 纸板：`--archive-board: #b87745`，用于商品盒和登录外盒。
- [observed] 接缝橙：`--archive-orange: #ff571f`，用于焦点、当前项、对话接缝和关键提示；不得铺满长篇正文背景。
- [observed] 色签：`--archive-blue`、`--archive-yellow`、`--archive-green`、`--archive-pink`，只区分来源或类别，不单独表达状态。
- [confirmed] 暗色主题保持同样的材料关系和对比层级，不把所有表面涂成同一黑色。

## Typography Rules

- [observed] 标题使用 `--archive-display`：`Avenir Next Condensed` / `Arial Narrow` / 系统中文无衬线后备。
- [observed] 编号、眉题和机器状态使用 `--archive-mono`。
- [confirmed] 大标题短、窄、密；正文保持正常字宽和舒适行高。营销标题不能挤掉首屏中的真实商品或明确状态。
- [confirmed] 界面文案直说动作和结果，避免使用成对的步骤铺垫连接句式。

## Layout Principles

- [confirmed] 全角色共享一套 Chrome。Chrome 承载品牌、全局目的地、偏好、通知和账号；Stage 承载当前任务；Clerk 是唯一对话输入区；Status 显示真实反馈。
- [confirmed] 根商城桌面为三段结构：16rem 墨色 Rail、弹性商品 Stage、21–27rem Clerk。商品与对话同时保留在视口中。
- [confirmed] 56rem 以下隐藏 Rail。目录是默认内容，Clerk 由固定动作唤起为底部 sheet；页面中不得复制第二个输入框。
- [confirmed] 店铺沿用商品盒墙；店长对话使用同一 Clerk 材料，桌面靠右、移动端靠底。
- [confirmed] 设置使用墨色索引轨和纸巾内容面。商家与运营后台沿用同一壳，采用发丝分隔、列表和表格，避免仪表盘卡片海。
- [confirmed] 页面宽度由内容任务决定；公开目录上限 96rem，操作记录优先横向可扫读。

## Component Styling

- [confirmed] 商品卡是可抽出的档案盒：真实媒体、稳定编号、店铺色签、商品名、价格和明确查看动作。盒子允许硬边阴影，普通工具面不使用这种阴影。
- [confirmed] Button 保持矩形、44px 触摸高度和可见边界。主要动作用油墨或接缝橙；破坏性动作必须保留文字标签。
- [confirmed] Badge 只表达状态或数量；Tag 只表达分类筛选；不得用胶囊代替普通文字或容器。
- [confirmed] Dialog 用于会打断任务的确认、账号、设置和详情。移动 Clerk 是可关闭的底部 sheet，不伪装成 Dialog。
- [confirmed] 空态、加载、失败均属于内容区域，必须说明当前事实和可执行动作；通知不可只放在视觉隐藏区域。
- [confirmed] 表单标签常驻；placeholder 只能补充示例。错误紧邻控件，提交中保留动作上下文。

## Motion & Interaction

- [confirmed] 商品盒在精确指针 hover 时可轻微抽出；图片只做极小尺度放大。其他页面不使用无目的漂浮动画。
- [confirmed] 触控按下反馈为 1px 位移；移动 Clerk 使用短距离、可中断的底部位移动画。
- [confirmed] `prefers-reduced-motion` 下移除盒子、图片、sheet 和骨架动画，不影响状态变化。

## Accessibility

- [confirmed] 所有交互目标至少 44×44px，键盘焦点使用 3px 接缝橙外框，并保留 3px offset。
- [confirmed] 状态不能只靠颜色；在线状态、点赞、错误和权限均需要文字或语义属性。
- [confirmed] 对话区具备命名，消息流使用 live region；移动 Clerk 支持 Escape、关闭按钮和命名遮罩。
- [confirmed] Dialog 恢复焦点，设置导航有可访问名称，320px 宽度下所有动作可达。
- [confirmed] 商品图片使用商品名作为替代文本；纯装饰盒盖、编号和色块隐藏于辅助技术。

## Source Evidence & Confidence

- [observed] path: `web/src/archive-ui.css`
  sha256: `190fc6745a23a76a96b8c9a312b6f815e104488bd34d3d8da34b989d0ce37a42`
  confidence: high
- [observed] path: `web/src/components/MarketplaceHome.tsx`
  sha256: `a4c803f99013bb7147a77ab3275165afe3828b8ecf02a91e95ff1259b1387675`
  confidence: high
- [observed] path: `web/src/components/MarketplaceListingCard.tsx`
  sha256: `412bcab6153b268a6390a028b46d4ba7dae0a543130d842ee6056cb12331bd10`
  confidence: high
- [observed] path: `web/src/App.tsx`
  sha256: `9907ae4f7375836fd98e175f210aea5837c93944809beb0398df48b14c94b51c`
  confidence: high
- [observed] path: `web/src/hooks/useMarketplaceCatalog.ts`
  sha256: `6375376b04ff6e3b8cd6f76cd9e6f0f850292392776ec9940ac7287f9d289527`
  confidence: high
- [observed] path: `web/src/components/LoginScreen.tsx`
  sha256: `7d54a8edf32e281c38dcca763dad694af4d3583fe515d116d65c977b7a2a4e84`
  confidence: high
- [observed] path: `web/src/components/WorkspaceSettingsDialog.tsx`
  sha256: `8dfda976d536457951d30f4896be3aaa2dc4aeb9a8a9fee1e1b378fe4c214c81`
  confidence: high
- [observed] path: `web/src/components/PlatformDashboard.tsx`
  sha256: `0c1bbe50b6d53da76f7395b1e3148db286922c8303c177e4a1a36e20c8fad10a`
  confidence: high
- [observed] path: `web/src/components/SubplatformAdminDashboard.tsx`
  sha256: `fba8e5e1919698ceb3b00a86fb1909911bd4b4969fde50c9c22ed0bd6649fcea`
  confidence: high
- [observed] path: `web/app/layout.tsx`
  sha256: `730ff95287bebfab601d109e62a77dbb8288b7d5cc5718ed230c81415b183ec2`
  confidence: high

## Known Gaps & Exceptions

- [confirmed] 第三方 subplatform 插件可保留自己的品牌色，但挂载壳、焦点、状态反馈和触摸目标仍遵循本基线。
- [confirmed] 运营表格允许横向滚动；不得通过缩小到不可读字号来塞进移动视口。
- [inferred confidence=medium] 真实目录为空时无法目视验证多种图片比例，商品盒仍需用实际生产目录持续抽查。

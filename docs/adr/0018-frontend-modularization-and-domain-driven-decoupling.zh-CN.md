# ADR 0018: 前端模块化与领域驱动解耦

## 状态

已采纳 (Accepted)

## 背景

MatchPlane 前端（`web/`）基于 Next.js 16、React 19、Tailwind CSS v4 和 Better Auth 构建。随着产品演进，系统支持了根商城撮合、多租户托管/远程店铺、统一身份认证（Better Auth）、通行密钥（Passkey）、身份绑定、店铺管理控制台与平台运营工作台，核心组件 `App.tsx` 逐渐膨胀为近 1600 行的单体控制器。

这带来了以下架构瓶颈：
1. **心智与维护负担沉重**：`App.tsx` 深度耦合了认证状态机（含网络抖动指数退避重试机）、URL 参数解析与浏览历史同步、15+ 个弹窗/抽屉（Sheets/Dialogs）、AI 导购客户跟进工单以及桌面/移动端顶栏导航。
2. **状态层层透传（Prop Drilling）**：全局偏好（语言、主题、色板）、认证用户、提示消息及回调函数在深层嵌套组件中逐层传递。
3. **组件目录扁平缺乏领域划分**：`web/src/components/` 下扁平堆放了 60+ 个组件与测试文件，缺乏业务领域分层。

## 决策

我们将前端架构重组为分层解耦模型，同时保持 100% 的 API 与测试兼容性：

```text
┌──────────────────────────────────────────────────────────┐
│                   Next.js App Router 路由                │
│               (app/page.tsx, app/[...path])              │
└────────────────────────────┬─────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────┐
│                    App.tsx 主调度器                      │
│                 (声明式组件组装与工作区派发)               │
├────────────────────────────┬─────────────────────────────┤
│      领域业务 Hooks        │     外壳与布局层 (Shell)    │
│  - useAuthSession          │  - PlatformHeader           │
│  - useSubplatformRoute     │  - SubplatformFullscreenHdr │
│  - useOwnedStores          │  - PlatformOverlaysHost     │
│  - useStoreHandoff         │  - PlatformFooter           │
│  - useMarketplaceCatalog   │                             │
├────────────────────────────┴─────────────────────────────┤
│                    领域组件模块                          │
│  account/  marketplace/  store/  admin/  ui/ (primitives)│
└──────────────────────────────────────────────────────────┘
```

1. **领域 Custom Hooks (`web/src/hooks/`)**：
   - `useAuthSession`：封装 Better Auth 会话拉取、瞬态网络错误（`408`, `429`, `5xx`）的 5 次指数退避重试、待定认证防抖、平台管理员权限鉴权及退出登录状态清理。
   - `useSubplatformRoute`：管理路径解析、动态子平台配置加载、URL 查询参数清洗（`?account=`, `?stores=1`, `?console=`, `?publish=1`, `?role=`) 及双向历史栈同步。
   - `useOwnedStores`：管理用户商铺归属列表的重试拉取、店铺控制台上下文及店主/运营权限检查。
   - `useStoreHandoff`：处理 AI 撮合联系交换意图、人工介入工单及幂等 Key 生成。
   - `useMarketplaceCatalog`：管理市场商品目录流、点赞及实时推荐。

2. **外壳与弹窗宿主解耦 (`web/src/components/shell/`)**：
   - `PlatformHeader`：独立封装顶栏导航、品牌 Logo 簇、偏好切换、开店入口与头像菜单。
   - `SubplatformFullscreenHeader`：承载子平台与插件沉浸式全屏顶栏。
   - `PlatformOverlaysHost`：统一挂载 15+ 个抽屉与对话框（`ListingSheet`、`ModeDialog`、`WorkspaceSettingsDialog`、个人资料/密码/通行密钥/绑定/店铺列表面板以及全局 Toast）。

3. **领域划分与显式导入**：
   - 按业务领域对组件进行分类归纳（`account`、`marketplace`、`store`、`admin`、`ui`、`shell`）。
   - 组件与 Hooks 从所属模块显式导入。不保留没有真实消费者的 barrel 门面，避免静态分析无法发现失效导出；未来如需公共门面，必须显式列出并由真实消费者使用。

## 影响

### 正向收益
- **高可维护性**：`App.tsx` 从 1597 行精简至 ~340 行清晰的声明式组装代码。
- **单测隔离**：Hooks 与 UI 组件可独立进行单元测试，无需每次 Mock 全量应用状态。
- **严格向后兼容**：现有 79 个测试文件（331 项测试）全部 100% 保持通过。
- **构建性能**：Next.js Turbopack 编译更加高效，组件重渲染范围可控。

### 注意事项
- 后续业务开发应遵循已定义的 Hook 与领域组件边界，避免在 `App.tsx` 中重新堆积无序状态。

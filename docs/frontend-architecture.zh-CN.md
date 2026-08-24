# MatchPlane 前端架构指南

本文档详细说明 MatchPlane Web 前端工程（`web/`）的架构设计、核心分层、状态流转与交互规范。

---

## 1. 技术栈选型

- **应用框架**：[Next.js 16](https://nextjs.org/)（App Router 模式，启用 Turbopack 与 Standalone 生产构建）
- **UI 运行时与动效**：[React 19](https://react.dev/)、[Motion](https://motion.dev/)（Framer Motion 13）
- **样式体系**：[Tailwind CSS v4](https://tailwindcss.com/) + 设计系统 Token 变量（`styles.css` 与 `retail-ui.css`）
- **UI 组件原语**：`@appica/ui-react`、`lucide-react`
- **身份与认证**：[Better Auth](https://better-auth.com/)（支持通行密钥 Passkey、OAuth 提供方集成与 API 密钥）
- **包管理与单测**：[Bun](https://bun.sh/)、[Vitest](https://vitest.dev/)、Testing Library

---

## 2. 目录结构

```text
web/
├── app/                        # Next.js App Router 路由与 API 端点
│   ├── layout.tsx              # 根 HTML 壳层（注入暗黑/主题初始化脚本）
│   ├── page.tsx                # 主商城入口挂载点
│   ├── [...platformPath]/      # 动态子平台/店铺独立主页路由
│   ├── admin/                  # 平台运营与超级管理员注册
│   ├── login/, register/       # 统一认证入口
│   └── api/                    # Route Handlers（认证、商城、平台管理、商铺）
├── src/                        # React 核心业务源码
│   ├── App.tsx                 # 顶层声明式应用主编排器
│   ├── hooks/                  # 领域驱动 Custom Hooks
│   │   ├── useAuthSession.ts   # Better Auth 会话与指数退避重试状态机
│   │   ├── useSubplatformRoute.ts # 路由解析与 URL 状态双向同步
│   │   ├── useOwnedStores.ts   # 店铺工作台上下文与商户权限控制
│   │   ├── useStoreHandoff.ts  # 联系交换 Consent 与 AI 人工跟进工单
│   │   ├── useMarketplaceCatalog.ts # 商品目录流、点赞与推荐聚合
│   │   └── index.ts            # Hooks 统一导出
│   ├── components/             # 领域划分 UI 组件
│   │   ├── shell/              # 外壳组件与弹窗集中宿主
│   │   │   ├── PlatformHeader.tsx
│   │   │   ├── SubplatformFullscreenHeader.tsx
│   │   │   └── PlatformOverlaysHost.tsx
│   │   ├── account/            # 个人资料、通行密钥、身份绑定、密码、登录会话
│   │   ├── marketplace/        # Chat-first 撮合、商品卡片、浮动导购员
│   │   ├── store/              # 店铺视口、入驻向导、商户管理控制台
│   │   ├── admin/              # 平台数据大盘、内容审核、站点配置
│   │   ├── Primitives.tsx      # 基础品牌标志、排版与弹簧动效常量
│   │   └── index.ts            # 组件统一导出
│   ├── lib/                    # 认证客户端、偏好设置、API 请求封装
│   ├── subplatform.ts          # 子平台 Manifest 解析与动态加载
│   ├── api.ts                  # 后端 API 交互函数
│   └── styles.css              # 主题变量、排版与响应式布局
└── package.json
```

---

## 3. 核心架构分层

### 3.1 声明式主编排器 (`App.tsx`)
`App.tsx` 作为全站顶层视图调度中心，不再直接维护底层复杂的异步副作用，而是声明式组装 Hooks 并向下分发渲染：
- **顶栏层**：`<PlatformHeader>`（标准模式）或 `<SubplatformFullscreenHeader>`（全屏插件模式）
- **工作区层**：`<MarketplaceHome>`（根商城）、`<StorefrontView>`（店铺页）、`<PluginHost>`（第三方插件）或 `<PlatformDashboard>`（平台运营）
- **弹窗层**：`<PlatformOverlaysHost>`（统一托管全量抽屉与对话框）
- **页脚层**：`<PlatformFooter>`

### 3.2 领域业务 Hooks 层 (`src/hooks/`)
1. **`useAuthSession`**：
   - 封装 Better Auth 会话解析，内置 5 轮指数退避重试（处理网络抖动、`408`、`429`、`5xx` 错误）。
   - 防抖近期待定认证状态（Pending Auth），避免未完成登录前错误重定向。
   - 角色权限拦截（非 `rootAdmin` / `rootSuperAdmin` 账号访问平台管理自动回退至买家角色）。
   - 提供幂等安全的 `signOut()` 与 `openSignIn()`。
2. **`useSubplatformRoute`**：
   - 静态解析路由路径并异步加载对应子平台的 `matchplane.subplatform.json`。
   - 消费并清洗 URL 参数（`?account=...`、`?stores=1`、`?console=...`、`?publish=1`）。
   - 双向同步工作区角色与浏览器历史栈（`window.history.replaceState`）。
3. **`useOwnedStores`**：
   - 重试拉取当前登录用户拥有或参与运营的商铺列表。
   - 管理店铺控制台的打开状态、上下文切换与 `canManageStore` 权限校验。
4. **`useStoreHandoff`**：
   - 确定性哈希计算意图幂等 Key。
   - 发起买家已验证联系方式交换申请（Contact Consent）并通知店员。
5. **`useMarketplaceCatalog`**：
   - 管理商品流拉取、离线缓存回退、点赞状态与 AI 意图推荐流。

### 3.3 外壳与弹窗宿主 (`src/components/shell/`)
- **`PlatformOverlaysHost`** 集中挂载 15+ 个弹窗与抽屉，避免在页面主 DOM 树中到处散落：
  - `WorkspaceSettingsDialog`（店铺控制台 / 个人资料 / 账号设置 / 通行密钥 / 身份绑定 / 密码管理 / 登录会话 / 我的店铺）
  - `ListingSheet`（商品详情抽屉与联系方式交换）
  - `ModeDialog`（测试环境与生产支付模式切换）
  - `AppNotice`（全局无障碍 Toast 提示）

---

## 4. UI 与交互设计规范

- **Chat-First 核心交互**：首页以自然语言意图理解为核心入口，降低买家筛选门槛。
- **Apple Design 弹簧动效**：统一定义物理弹簧曲线（`spring = { type: "spring", bounce: 0, duration: 0.38 }`），严格遵守 `reducedMotion="user"` 减弱动效偏好。
- **深浅色主题 Token**：全量界面颜色基于语义化 CSS 变量（`--ink`, `--ivory`, `--paper`, `--cactus`, `--clay`, `--surface`）。
- **移动端与自适应**：从 `320px` 窄屏手机到 `1440px` 桌面宽屏均具备自然的换行、间距与抽屉滑出体验。

---

## 5. 开发与测试指令

```bash
# 运行 Vitest 单元与集成测试（79 个测试文件，331 项测试）
bun run test

# 执行类型检查与 Next.js 生产环境构建编译
bun run check

# 启动本地热重载开发服务器（默认端口 4173）
bun run dev
```

# @matchplane/web

MatchPlane 官方前端工程 — 提供主商城 AI 意图撮合大厅、多租户店铺独立主页、Better Auth 统一身份认证、通行密钥（Passkey）管理、AI 导购聊天以及平台运营控制台。

---

## 核心特性

- **Chat-First 撮合引擎**：基于自然语言意图理解进行商品匹配与可解释推荐卡片展示。
- **统一身份认证体系**：无缝集成 Better Auth，支持通行密钥（Passkey）、密码认证、OAuth 登录、身份绑定与多端会话管理。
- **多租户子平台与独立店铺**：动态挂载子平台 Manifest 配置，支持独立品牌标识、托管店铺与远程店铺入驻。
- **商户与商城运营工作台**：店铺商品目录审核、店员权限管理、商务条款配置与支付模式（测试/生产）切换。
- **低噪设计系统**：汲取 Anthropic 质感艺术与 Apple 物理弹簧动效，支持深浅色主题 Token 与移动端友好响应式设计。

---

## 快速上手

### 环境要求

- [Bun](https://bun.sh/) `>= 1.3.14`
- [Node.js](https://nodejs.org/) `>= 22.12.0`

### 安装与运行

```bash
# 安装依赖
bun install

# 启动本地开发服务（监听 0.0.0.0:4173）
bun run dev

# 执行单元测试与组件集成测试（Vitest）
bun run test

# 执行全量校验（测试 + Next.js Turbopack 生产编译）
bun run check
```

---

## 工程目录概览

- `app/`：Next.js App Router 页面路由与 API Route Handlers（`/api/*`）。
- `src/App.tsx`：顶层声明式应用主编排器。
- `src/hooks/`：领域驱动 Custom Hooks（`useAuthSession`、`useSubplatformRoute`、`useOwnedStores`、`useStoreHandoff`、`useMarketplaceCatalog`）。
- `src/components/`：领域划分组件（`shell/`、`account/`、`marketplace/`、`store/`、`admin/`、`Primitives.tsx`）。
- `src/lib/`：Better Auth 客户端、界面偏好与商城会话辅助函数。
- `src/styles.css`：Tailwind CSS v4 样式与语义化主题 Token。

详细架构设计请参阅 [docs/frontend-architecture.zh-CN.md](../docs/frontend-architecture.zh-CN.md) 与 [ADR 0018](../docs/adr/0018-frontend-modularization-and-domain-driven-decoupling.zh-CN.md)。

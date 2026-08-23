# ADR 0016：分层服务架构

- 状态：已接受
- 日期：2026-08-23

## 背景

Gateway 与 payment-service 原先在 HTTP 处理器和 `PgStore` 方法中混合业务编排、授权与持久化逻辑。`docs/backend-architecture-refactor.md` 已定义目标分层，但缺少可复用的 crate 边界。

## 决定

1. 新增 `matchplane-http` 作为共享接口层 crate，提供结构化 API 错误、Bearer 认证辅助函数，以及可选 `storage` 特性下的 `StorageError` 映射。
2. 新增 `matchplane-application` 作为应用层 crate，通过端口 trait（如 `OrderWriter`）封装用例；首个落地用例为 `OrderService::place_order`。
3. Gateway 的 `/v1/orders` 路径改为：HTTP 解析 → `OrderService` → `PgStore`，不再在 handler 内直接构造 `SubmitOrder`。
4. `matchplane-config::ProviderRegistry` 增加 builder 与枚举 API，为运行时 provider 加载做准备；支付 `GatewayFactory` 仍是 payment 类 provider 的参考实现。

## 结果

- 服务适配器可逐步变薄，市场类用例可按相同模式迁入 application 层。
- API 错误在 gateway 侧统一为 `{ code, error }` 结构（与 payment-service 对齐）。
- 后续工作：集中 marketplace 授权、后端 OAuth/AI 管理 API、从 `matchplane-storage` 中提取剩余业务状态机。

## 参考

- `docs/backend-refactor-plan.zh-CN.md`
- `ARCHITECTURE.zh-CN.md`

# 后端架构重构

## 目标

MatchPlane 的生产就绪后端结构。

## 图层

- 领域层：实体、规则、不变量。
- 应用层：工作​​流程和编排。
- 基础设施层：PostgreSQL、Kafka、Valkey 和外部服务。
- 接口层：HTTP、gRPC 和 MCP 适配器。

## 提供商注册表

所有外部功能都应使用注册表：

- 验证
- OAuth
- 人工智能模型
- 付款
- 通知

配置更改不应需要重新编译核心服务。

## 安全

- 集中授权
- 加密的秘密
- 审计事件
- 启动验证
- 一致的API错误

## 迁移

1. ~~提取应用服务~~（进行中：`matchplane-application` 已落地订单簿用例）
2. ~~引入提供商注册中心~~（`ProviderRegistry` + builder 已就绪，运行时加载待接）
3. 创建管理配置 API
4. 迁移集成
5. 添加集成测试

共享 HTTP 层（`matchplane-http`）与 gateway 结构化错误已落地。

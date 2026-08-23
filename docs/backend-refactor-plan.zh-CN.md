# 后端生产重构计划

## 目标

将后端重构为更清晰的生产边界，而无需更改域保证。

## 服务边界

- API 层：仅限 HTTP/gRPC 传输。
- 应用层：用例、授权、编排。
- 领域层：市场规则和不变量。
- 基础设施层：PostgreSQL、Kafka、Valkey、外部提供商。

## 迁移顺序

1. ~~提取应用服务~~（`matchplane-application` 已承载订单簿与 generic marketplace 用例）
2. ~~引入提供商注册中心~~（`ProviderRegistry` + builder 已就绪，运行时加载待接）
3. 创建管理配置 API
4. 迁移 legacy marketplace 适配器与 party 注册流程
5. 添加集成测试

共享 HTTP 层、gateway 结构化错误、以及 generic marketplace 薄适配器改造已落地。。

# 匹配平面架构

## 分层边界

MatchPlane 后端采用四层结构，将传输、编排、领域规则与基础设施解耦：

```text
Interface (services)     gateway, payment-service, federation-hub, ...
        |
Application (crates)   matchplane-application — 用例、端口、授权编排
        |
Domain (crates)        matchplane-domain, matchplane-engine — 纯类型与确定性规则
        |
Infrastructure         matchplane-storage, matchplane-cache, matchplane-payments, ...
```

共享 HTTP 适配器集中在 `matchplane-http`：结构化 `{ code, error }` 响应、Bearer 认证辅助函数，以及可选的 `storage` 特性（将 `StorageError` 映射为 HTTP 错误）。服务二进制文件应只做请求解析与序列化，业务编排下沉到 `matchplane-application`。

外部能力（OAuth、AI、支付、通知）通过 `matchplane-config::ProviderRegistry` 注册；运行时加载由应用服务负责，配置变更不应要求重新编译核心领域代码。支付服务中的 `GatewayFactory` 是支付类 provider 的参考实现，后续 OAuth/AI 管理 API 应与之对齐。

迁移顺序见 `docs/backend-refactor-plan.zh-CN.md`。当前已完成：共享 HTTP 层、订单簿应用服务、provider registry builder，以及 gateway 订单路径的薄适配器改造。

## 权威性和一致性

PostgreSQL 是最终的事实来源。每个外部可见的命令首先被持久化
它的幂等性记录和事务发件箱行。 Kafka 发布至少一次；消费者
使用 `consumer_inbox` 保护 PostgreSQL 效果并使用原子流保护 Valkey 投影
顺序。没有正确性属性依赖于缓存锁或 Kafka 一次性模式。

每个市场都是一个逻辑订单簿分片。 Kafka 按 `market_id` 键命令，而 PostgreSQL
具有单调递增的隔离令牌的租约可以防止过时的匹配器写入。这
匹配器为每个拥有的分片运行一个单线程事件循环并调用纯
`matchplane-engine`状态转换库。

## 数据流

```text
Client -> Gateway -> PostgreSQL(order + outbox)
                         |
                    Event relay -> Kafka command partition
                                      |
                                  Matcher -> deterministic engine
                                      |
                         PostgreSQL(inbox + facts + outbox)
                                      |
                    Event relay -> Kafka facts -> Projector -> Valkey
```

关系当前状态和仅追加`domain_events`一起提交。匹配者
恢复最近的校验和验证快照，然后重播 PostgreSQL 事件日志。瓦尔基
每当其序列有间隙时，就会根据事实重建。

## 市场、谈判和收入流

卖家列表和买家请求是围绕相同的域中立概念的垂直适配器：
需求/供应参与者、结构化意图、可解释的介绍和同意的
联系交流。双方低层参与者身份相同； "买方"和
"卖家"是汽车标签，而不是单独的帐户实施。未来的约会或服务
垂直可以重用相同的原语，仅替换其架构、排名功能、复制和
安全政策。

可解释的匹配创建 `offline_deal`；卖家曝光事件衡量的路径是
印象询问和联系同意。联系人和查看位置在 HTTP 上加密
边界，并且每个接触决定都经过审核。卖家必须先接受联系请求
任何一方都可以检索另一方列入允许名单的电话/微信详细信息。

检索是版本化 `matchplane.retrieval/v1` 边界后面的子平台适配器。这
root 接收规范资产 ID、有界分数、提供者/模型版本和原因；确实如此
不需要矢量数据库或交换原始矢量。目前的 pgvector 工作者只是一个
现有部署的兼容性提供程序。根策略仍然验证范围、当前资产
状态、曝光计费、介绍、联系同意和结算。

代理路由同样是平台拥有的控制平面操作。根仅选择
授权直接子级，调用具有有限多步预算的配置提供者，以及
记录`cost_bearer = platform`以及`platform_ai_usage`中的提供者使用情况。提供商密钥保留
服务器端；买家、卖家和安装的子平台永远不会收到代币账单或浏览器
凭据。托管呼叫可根据每个主题和部署范围内的小时配额进行允许；
外部买家/卖家代理使用呼叫者资助的切换和 MCP 功能，而不是消耗
根提供商帐户。技能和 MCP 工具是子平台拥有的扩展点
稳定的`matchplane.agent/v1`信封，不是绕过授权或未经授权消费的借​​口
预算。

对于`offline_direct`，买卖双方自行结算车辆价格。隔离支付
服务是可选的。主要的平台外收入政策是卖家资助的促销：固定、
展示次数、点击次数或合格潜在客户营销活动在促销优惠时收费，因此
平台不需要观察后续的微信/电话交易。租客也可以选择
纳入披露的交易费用或混合政策。在线订单簿交易使用市场拥有的
仅在启用该政策时收取费用；分类帐借记买方的总金额，贷记
卖家的净额，并在单独的过账中记入平台佣金账户。贸易事实
公开所有四个值而不是嵌入隐藏的价差。

支付网关配置是数据驱动的，但凭据保留在 PostgreSQL 外部。测试和
生产路由是独立的，模式开关经过版本控制和审核，以及未解决的旧模式
付款会阻止转换。退款以交易方式保留总可退款能力。发布
发票是不可更改的；退款会产生更正请求和加密的红字工件。

## 联合会

节点 A 拥有汽车数据，节点 B 拥有电子数据，节点 C 是联合中心。甲和乙
发布标准化书籍增量、摘要和健康事实。 C 维护可重建聚合
查看 AI 候选者并将其路由回其源节点。跨节点结算使用过期的、
幂等`reserve -> confirm/abort`传奇；每个源节点保留最终提交权限。

控制平面 RPC 使用带有协议协商和 mTLS 挂钩的 gRPC。卡夫卡携带订单簿和
域事实。每个信封都包含强制性身份、沿袭、分片、版本、时间戳、
和 ADR 0003 中描述的有效负载哈希字段。

## 前端与交互层

MatchPlane 前端工程（`web/`）采用基于 Next.js 16 + React 19 的领域解耦架构，将状态机与视图层彻底分离：

```text
Next.js App Router (app/) -> 声明式主编排器 (App.tsx)
                                 |
        +------------------------+------------------------+
        |                                                 |
领域业务 Hooks (hooks/)                       外壳与弹窗宿主 (components/shell/)
  - useAuthSession                              - PlatformHeader
  - useSubplatformRoute                         - SubplatformFullscreenHeader
  - useOwnedStores                              - PlatformOverlaysHost
  - useStoreHandoff                             - PlatformFooter
  - useMarketplaceCatalog                                 |
                                             领域组件库 (components/)
                                               - account/ marketplace/ store/ admin/ ui/
```

详细规范请参阅 `docs/frontend-architecture.zh-CN.md` 与 `docs/adr/0018-frontend-modularization-and-domain-driven-decoupling.zh-CN.md`。

## 部署

A、B 和 C 应在独立的 Kubernetes 故障域中运行。无状态 API 和工作人员使用
部署；匹配器使用 StatefulSets 来稳定进程身份；数据库和卡夫卡是
生产中由操作员管理。 Helm 图表接受外部 PostgreSQL、Kafka 和 Valkey
端点。 Local Compose 提供单节点 KRaft Kafka、Valkey 和可重现的 PostgreSQL
包含 TimescaleDB 和 pgvector 的图像。

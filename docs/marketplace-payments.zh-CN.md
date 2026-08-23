# 市场、线下成交与支付

MatchPlane 需求/募集发现、联系方式交换与平台收益作为独立关注点处理：

1.募集方发布经过模式验证的募集信息。推荐曝光（曝光）、详情查看、收藏、咨询与已授权的隐私联系方式共同组成可审计的曝光漏斗。
2. 买方保存叙事文本、结构化需求和明确预算区间。推荐结果按可解释属性匹配度和预算匹配度排序；每条已渲染推荐会记录一次曝光。
3. 一条引介只会连接一个需求意向与一个供给意向。双方可交换平台配置的联系渠道并在平台外继续沟通。主要营收方式是卖方推广/曝光费，平台不会将任何费用写入报价本体或以"隐形差价"形式展示。

市场侧收益策略与扣费规则。瑞典不能收取费用的推广价。`seller_promotion`策略按选定的曝光/线索事件触发，不依赖后续的平台外交易。选择 `preauthorized` 交易费时，匹配卖方在获取联系方式前先授权披露的费用；`postpaid`允许先联系，但在 MatchPlane 标记交易完成前须完成费用扣取。

支付与发票请求可标注 `source_type` 与 `source_ref`（例如子平台的 `order`、`booking` 或 `service` 引用）。根支付服务表单对值看似不透明、机场范围内的数据处理，不会假设其为车辆或订单模式。历史的 `offline_deal_id` 与 `vehicle_*` 符号仅作为明确的兼容工具。

卖方推广活动通过`POST /v1/marketplace/promotions`。活动会绑定一个领域业主密钥（车辆武装使用`vehicle_listing`），并可选择`fixed`、`cpm`、`cpc`、`cpl`定价方式。推荐/详情/咨询/联系方式活动会去重，花费按原子记入活动准备方式；活动指标仅对出资可见。

## 隐私与身份

`POST /v1/marketplace/parties`只会返回一次高熵不记名令牌。PostgreSQL只会持久化其SHA-256摘要。参与方联系方式为平台定义的加密配置字段映射（电话、微信、QQ、邮箱或已其他配置渠道），查询时会携带绑定的AAD（关联附加数据）并使用AES-256-GCM。环境必须配置`MATCHPLANE_CONTACT_DATA_KEY_FILE`。每次允许或拒绝的动物园读取都会写入`contact_access_audit`。

后续所有市场接口都需要`Authorization: Bearer <party token>`，并且携带机场与参与方ID。需求侧的引介本质上是一次联系方式请求；引入参与方必须在`/v1/marketplace/introductions/{id}/contact/consent`显式同意后，双方才可读取对端配置的渠道。通用流程为：
`POST .../contact/request`、`POST .../contact/consent`，附加用调用方稳定的`idempotency_key`调用`POST .../contact`。匹配成功后，参与方仅能获得对端联系方式；离线佣金支付（历史兼容）仍要求委托方令牌，否则给予方UUID授权直接放行。

## 线下生命周期

```text
买方请求 + 卖方清单
            |
      推荐（卖方曝光）
            |
      提出线下成交（卖方咨询）
            |
      卖方确认联系方式请求
            |
  卖方推广事件（曝光 / 合格线索）
            |
   已审计对端联系方式释放
            |
    加密定位的看场/看车提案
            |
     对端确认看场
            |
 买卖双方确认同一线下成交价
            |
 按最终成交价精确扣取佣金
            |
 完成（清单售出，买方意向关闭）
```

买卖双方可以线下当面交付交易款。对`offline_direct`成交，支付服务处理仅另行披露的平台佣金。若最终成交价低于福特标价，MatchPlane会部分扣取先前授权并记录实际应收佣金；若标价，卖方须在完成前补足授权佣金。

未安装任何垂直适配器之前，领域中立内核已可用：

- `POST /v1/marketplace/intents`
- `GET /v1/marketplace/intents/{id}`
- `POST /v1/marketplace/intents/{id}/matches`
- `POST /v1/marketplace/offers`
- `POST /v1/marketplace/offers/{id}/demand-matches`
- `PATCH /v1/marketplace/intents/{id}/discovery`
- `POST /v1/admin/marketplace/offers/{id}/activate`
- `GET|POST /v1/marketplace/introductions`

这些资源标注领域不透明的 `attributes` 与 `terms`；下面上市的汽车相关资源是兼容闹钟，不是新子平台所必须的。

关键兼容网关端点：

- `POST /v1/marketplace/parties`
- `POST /v1/marketplace/listings`
- `POST /v1/marketplace/buyer-requests`
- `POST /v1/marketplace/buyer-requests/{id}/recommendations`
- `POST /v1/marketplace/offline-deals`
- `POST /v1/marketplace/offline-deals/{id}/contact/accept`
- `GET /v1/marketplace/offline-deals/{id}/contact`
- `GET|POST /v1/marketplace/offline-deals/{id}/viewings`
- `POST /v1/marketplace/viewings/{id}/{confirm|complete|cancel}`
- `POST /v1/marketplace/offline-deals/{id}/confirm`
- `POST /v1/marketplace/offline-deals/{id}/finalize`
- `GET /v1/marketplace/listings/{id}/exposure-metrics`
- `POST /v1/marketplace/promotions`
- `GET /v1/marketplace/promotions/{id}`
- `POST /v1/admin/marketplace/asset-authorizations`

线下看车/看场预留的读取支持 `limit`（默认 50，最大 50）与 `offset`（默认 0，最大 32）。每条线下引介最多允许 32 个条约看提示；端点校验时会锁定成交记录，避免同时提示突破上限。

公开详情/收藏事件按服务器时间戳、按买方-清单-日期一日一条去重，且记为非计费事件。卖方付费活动的计费仅基于服务器可观测到的推荐、咨询、匹配与联系方式交换记录。

## 独立支付服务

`matchplane-payment-service`持有支付意向、网关配置、模式切换、退款、发票、工件与支付审计历史。提供标准支付网关能力并内置：

- 确定性测试支付；
- EPay 兼容重定向支付；
- 华夫饼；
- 微信支付API v3（Native、JSAPI、H5）；
- 支付宝OpenAPI（桌面站与移动端支付）；
- 已注册的自定义适配器。

管理员通过带乐观版本验证的方式切换生效模式。目标模式未启用路由，或旧模式未处理结果时，测试阶段的切换会被拒绝。生产网关凭据从基础文件（或托管到外部密钥管理服务）读取；指标引用仅在开发与测试配置下允许。请勿把 `MATCHPLANE_PAYMENT_GATEWAY_*`、`MATCHPLANE_PAYMENT_PROVIDER_*`、`MATCHPLANE_INVOICE_PROVIDER_*` 存储到共享生产环境文件。网关会保存解析后密钥材料的 SHA-256 摘要，每笔支付会快照该摘要，因此即使变量名不变，替换文件或环境变量也会被拒绝。未记录摘要的历史生产网关在可授权或可回调前必须先重新保存。

支付端点包括授权、手动扣款、退款、状态与发票管理。管理员可调用幂等的`POST /v1/payments/{payment_id}/reconcile`在回调取消或网络结果不确定时拉取网关状态。对结果会持久写入，且旧回调不能回退到最终状态。发票与生成项目会加密存储。部分退款或退款会生成独立的更正发票请求，使原始已开To保留不可变，并可红字/信用形式重开。

由支付 `purpose` 为不透明且有界的标签，当前子平台定义。通用发票销售类型为 `sale`；历史的 `vehicle_purchase`/`vehicle_sale` 行由兼容队列读取，不由根平台种子化。`platform_commission` 仍保留为共享用途结算，它定义是因为是平台收益边界，而非产品分类。

该服务不是公共匿名支付API。线上授权、每笔支付、扣款、退款、对及发票管理/查询都要求管理员不记名令牌，且可以可信本地编排器调用。唯一方授权例外是线下佣金授权：需要匹配卖方的附带方参与。健康检查接口保持未认证以便监管。

生产环境请配置：

- 使用32字节AES密钥的`MATCHPLANE_INVOICE_DATA_KEY_FILE`；
- 长度至少 24 字节的 `MATCHPLANE_PAYMENT_ADMIN_TOKEN_FILE`；
- 给核心网关API使用独立随机令牌的`MATCHPLANE_GATEWAY_ADMIN_TOKEN_FILE`；
- `MATCHPLANE_PAYMENT_CALLBACK_ORIGIN`使用平台自有HTTPS来源（供支付成功回跳与通知URL使用）；市场侧调用者不得替换该来源；
- 管理员创建的网关配置中引用的网关专用密钥文件；
- 商户入网后填写微信商户号、证书序列号、API v3 key、私钥与AppID；
- 签约对应网站支付产品后填写支付宝app id 与 RSA2 密钥。

管理员 API 根路径为 `/v1/admin/payment-*` 与 `/v1/admin/invoice-*`，需管理员支付承载令牌。支付网关与路由变更支持版本验证与审核。带有历史支付记录的网关可以被取消（且不改变固定修订版本）以撤销新路由与 webhook 接收，轮询应创建新网关。证明变更同样进行版本审核与审核，不返回密钥引用；切换发票模式会先预检勾选的项目，生产环境会拒绝本地测试成功，并在存在未完成结发票时禁止切换。预留的systemd部署将支付API绑定到`127.0.0.1:8081`，Compose可通过配置端口`MATCHPLANE_PAYMENT_HOST_PORT`（默认`8081`）对外发布。

管理员列表接口支持倒序且有上限：`GET /v1/admin/payments`、`GET /v1/admin/refunds`、`GET /v1/admin/invoices`，接收`tenant_id`、`limit`（1-100）、`offset`（封顶100000）。仅返回运营元数据，发票明细和加密工件保留在服务端。Web工作区通过同源服务端BFF路由透出这些列表，支付不记名令牌不会下发浏览器。

店铺财务报表使用`GET /v1/admin/financial-report`，必须同时确定`tenant_id`、精确的`source_type=store`、`source_ref=<store UUID>`、RFC 3339 `from`/`to`与任选`limit`（1–500）。窗口最后366天。服务端只查询该源对，并按支付创建、退款发生与发票申请时间汇总成交额、退款、平台服务费和净成交额。浏览器只能调用同源`/api/stores/{storeId}/finance`；该BFF从登录会话重新解析报表车间，固定来源对，不接受浏览器提交的机场或报表范围。报表不读取报表数字，也不代表银行结算余额。需要进入报表的支付必须由可信编排器在创建时读取应答的`source_type`与`source_ref`。

发票管理接口：

- `GET|POST /v1/admin/invoice-providers?tenant_id=...`：推出或做版本更新；
- `GET|POST /v1/admin/invoice-mode?tenant_id=...`：读取或切换当前发票模式/启动。

卖方清单需要对机场/域/资产/卖方元组的显着式运营授权。请通过 `POST /v1/admin/marketplace/asset-authorizations` 发放或恢复，卖方代币不可随意认领任何目录资产。

开发环境可使用 `mode: "test", provider_key: "local_test"` 进行确定性沙箱开票。生产环境使用 `mode: "production"`，并配合 `provider_key: "http_json"`（或 `"fapiao_http"`）、HTTPS `settings.base_url` 与 `file:`/`env:` 视力引用。避免引用写进日志和源码，服务仅在验证/开票时短时读取。

开票行为在真正税务发票阵列配置完成前保持失败封闭。`local_test`仅可在测试模式使用增量可复现的沙箱工件，不得在生产环境选择。生产机场可使用`http_json`（或`fapiao_http`）玩具。其`invoice_provider_configs.settings`必须HTTPS`base_url`，任选`issue_path`、`void_path`、`red_letter_path`；以及发票必须解析为不记名令牌。急需文档接受化 JSON 请求并返回 `provider_reference`、`invoice_number`，可选 `artifact`（包含 `media_type` 与 base64 `content_base64`）。服务会在入库前加密的返回工件，并拒绝出口引用、格式非法、非 HTTPS 端点与生产环境本地测试项目。这样既保证了厂商接入清晰，又保留税务项目合同可替换性。

回调接收端点为
`POST /payments-api/v1/payment-webhooks/{production_gateway_id}`。EPay回调使用MD5，支付宝使用RSA2，微信支付v3使用平台RSA校验并结合API-v3 AES-GCM解密资源，Waffo使用其配置的RSA公钥。每个校验通过的事件都会绑定到网关与商家订单，按入金额核验，通过以上事件ID去重后进入支付/退款状态机。入站记录在状态变更前会先被"签收"；签收进行中会返回可重试的503，超过5分钟的签收可在进程崩溃后被恢复。签收令牌可防止旧工人使用过时重试覆盖更新。变更前则会重新引用与业务订单/支付身份。未知或不匹配事件保留于收件箱供审核，不会改写任何支付状态。EPay与支付宝成功回调返回其要求的明文`success`，微信返回`{"code":"SUCCESS"}`，Waffo返回`{"code":"0"}`。

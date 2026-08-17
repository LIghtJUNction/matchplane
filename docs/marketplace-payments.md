# 市场、线下成交与支付

MatchPlane 将需求/供给发现、联系方式交换与平台收益作为独立关注点处理：

1. 供给方发布经过 schema 校验的供给信息。推荐曝光（impression）、详情查看、收藏、咨询与已授权的隐私联系方式共同组成可审计的曝光漏斗。
2. 买方保存叙事文本、结构化需求和明确预算区间。推荐结果按可解释属性匹配度和预算匹配度排序；每条已渲染推荐会记录一次曝光。
3. 一条引介只会连接一个需求意向与一个供给意向。双方可交换平台配置的联系渠道并在平台外继续沟通。主要营收方式是卖方推广/曝光费，平台不会将任何费用写入报价本体或以“隐形差价”形式展示。

市场侧负责收益策略与扣费规则。卖方不能下调租户配置的推广价。`seller_promotion` 策略按已选的曝光/线索事件计费，不依赖后续是否发生平台外交易。可选的 `preauthorized` 交易费要求匹配卖方在获取联系方式前先授权披露的费用；`postpaid` 允许先联系，但在 MatchPlane 标记交易完成前仍须完成费用扣取。

支付与发票请求可携带 `source_type` 与 `source_ref`（例如子平台的 `order`、`booking` 或 `service` 引用）。根支付服务将该对值当作不透明、租户范围内的数据处理，不会假设其为车辆或订单 schema。历史的 `offline_deal_id` 与 `vehicle_*` 字段仅作为明确的兼容适配器可见。

卖方推广活动通过 `POST /v1/marketplace/promotions` 创建。活动会绑定一个领域所有者 key（车辆适配器使用 `vehicle_listing`），并可选择 `fixed`、`cpm`、`cpc`、`cpl` 定价方式。推荐/详情/咨询/联系方式事件会去重，并将花费按原子方式记入活动预算；活动指标仅对出资卖方可见。

## 隐私与身份

`POST /v1/marketplace/parties` 仅会返回一次高熵 bearer token。PostgreSQL 只会持久化其 SHA-256 摘要。参与方联系方式为平台定义的加密受限字段映射（电话、微信、QQ、邮箱或其他已配置渠道），查询时会携带上下文绑定的 AAD（关联附加数据）并使用 AES-256-GCM。生产环境必须配置 `MATCHPLANE_CONTACT_DATA_KEY_FILE`。每次允许或拒绝的联系人读取都会写入 `contact_access_audit`。

后续所有市场接口都需要 `Authorization: Bearer <party token>`，并且携带租户与参与方 ID。需求侧的引介本质上是一次联系方式请求；供给参与方必须在 `/v1/marketplace/introductions/{id}/contact/consent` 显式同意后，双方才可读取对端配置的渠道。通用流程为：
`POST .../contact/request`、`POST .../contact/consent`，随后用调用方稳定的 `idempotency_key` 调用 `POST .../contact`。匹配成功后，参与方仅能拿到对端联系方式；离线佣金支付（历史兼容）仍要求卖方 token，单纯给出 party UUID 不足以直接放行。

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

买卖双方可以线下当面交付交易款。对 `offline_direct` 成交，支付服务仅处理另行披露的平台佣金。若最终成交价低于买方标价，MatchPlane 会部分扣取先前授权并记录实际应收佣金；若高于标价，卖方须在完成前补足授权佣金。

未安装任何垂直适配器之前，领域中立内核已可用：

- `POST /v1/marketplace/intents`
- `GET /v1/marketplace/intents/{id}`
- `POST /v1/marketplace/intents/{id}/matches`
- `POST /v1/marketplace/offers`
- `POST /v1/admin/marketplace/offers/{id}/activate`
- `GET|POST /v1/marketplace/introductions`

这些资源携带领域不透明的 `attributes` 与 `terms`；下面列出的汽车相关资源是兼容适配器，不是新子平台所必须。

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

线下看车/看场预约的读取支持 `limit`（默认 50，最大 50）与 `offset`（默认 0，最大 32）。每个线下引介最多允许 32 条约看提案；提案额度校验时会锁定成交记录，避免并发提案突破上限。

公开详情/收藏事件按服务器时间戳、按买方-清单-日期一日一条去重，且记为非计费事件。卖方付费活动的计费仅基于服务器可观测到的推荐、咨询、匹配与联系方式交换记录。

## 独立支付服务

`matchplane-payment-service` 持有支付意向、网关配置、模式切换、退款、发票、提供商工件与支付审计历史。它提供标准支付网关能力并内置适配器：

- 确定性测试支付；
- EPay 兼容重定向支付；
- Waffo Pancake；
- WeChat Pay API v3（Native、JSAPI、H5）；
- Alipay OpenAPI（桌面站与移动端支付）；
- 已注册的自定义适配器。

测试与生产配置分离。管理员通过带乐观版本校验的方式切换生效模式。若目标模式未启用路由，或旧模式仍有未处理结果，则切换会被拒绝。生产网关凭据从受限文件（或将文件落盘的外部密钥管理服务）读取；环境变量引用仅在开发与测试配置下允许。请勿把 `MATCHPLANE_PAYMENT_GATEWAY_*`、`MATCHPLANE_PAYMENT_PROVIDER_*`、`MATCHPLANE_INVOICE_PROVIDER_*` 凭据放入共享生产环境文件。凭据不存数据库。每个网关都会存储解析后密钥材料的 SHA-256 摘要，每笔支付会快照该摘要，因此即使变量名不变，替换文件或环境变量也会走 fail-closed。未记录摘要的历史生产网关在可授权/可回调前必须先重新保存。

支付端点包括授权、手动扣款、退款、状态查询与发票管理。管理员可调用幂等的 `POST /v1/payments/{payment_id}/reconcile` 在回调缺失或网络结果不确定时拉取网关状态。对账结果会持久写入，且旧回调不能回退到终态。发票收件人与生成工件会加密存储。部分退款或全额退款会生成独立的更正发票请求，使原始已开票据保持不可变，随后可以红字/credit 工件形式重开。

支付 `purpose` 为不透明且有界的标签，由当前子平台定义。通用发票销售类型为 `sale`；历史的 `vehicle_purchase`/`vehicle_sale` 行由兼容适配器读取，不由根平台种子化。`platform_commission` 仍保留为共享结算用途，因为它定义的是平台收益边界，而非产品分类。

该服务不是公共匿名支付 API。线上授权、每笔支付、扣款、退款、对账及发票管理/查询都要求管理员 bearer token，且仅供可信本地编排器调用。唯一 party-auth 例外是线下佣金授权：需要匹配卖方的一次性参与方凭据。健康检查接口保持未认证以便监管。

生产环境请配置：

- 用 32 字节 AES key 的 `MATCHPLANE_INVOICE_DATA_KEY_FILE`；
- 长度至少 24 字节的 `MATCHPLANE_PAYMENT_ADMIN_TOKEN_FILE`；
- 给核心网关 API 使用独立随机 token 的 `MATCHPLANE_GATEWAY_ADMIN_TOKEN_FILE`；
- `MATCHPLANE_PAYMENT_CALLBACK_ORIGIN` 使用平台自有 HTTPS origin（供支付提供商回跳与通知 URL 使用）；市场侧调用者不得替换该 origin；
- 管理员创建的网关配置中引用的网关专用密钥文件；
- 商户入网后填写微信商户号、证书序列号、API v3 key、私钥与 AppID；
- 签约对应网站支付产品后填写支付宝 app id 与 RSA2 密钥。

管理员 API 根路径为 `/v1/admin/payment-*` 与 `/v1/admin/invoice-*`，需支付管理员 bearer token。支付网关与路由变更支持版本校验与审计。带有历史支付记录的网关只能被禁用（且不改变固定修订版本）以撤销新路由与 webhook 接收，凭据轮换应创建新网关。发票提供商变更同样进行版本校验与审计，不返回密钥引用；切换发票模式会先预检选中的提供商，生产环境会拒绝 local-test 提供商，并在存在未完结发票时禁止切换。打包的 systemd 部署将支付 API 绑定到 `127.0.0.1:8081`，Compose 可通过配置端口 `MATCHPLANE_PAYMENT_HOST_PORT`（默认 `8081`）对外发布。

管理员列表接口支持倒序且有上限：`GET /v1/admin/payments`、`GET /v1/admin/refunds`、`GET /v1/admin/invoices`，接收 `tenant_id`、`limit`（1–100）、`offset`（封顶 100000）。仅返回运营元数据，发票账单明细和加密工件保留在服务端。Web 工作区通过同源服务端 BFF 路由透出这些列表，支付 bearer token 不会下发浏览器。

发票管理接口：

- `GET|POST /v1/admin/invoice-providers?tenant_id=...`：列出或做版本更新；
- `GET|POST /v1/admin/invoice-mode?tenant_id=...`：读取或切换当前发票模式/提供商。

卖方清单需要对租户/域/资产/卖方 tuple 的显式运营授权。请通过 `POST /v1/admin/marketplace/asset-authorizations` 发放或回收，卖方 token 不可随意认领任意目录资产。

开发环境可使用 `mode: "test", provider_key: "local_test"` 进行确定性沙箱开票。生产环境使用 `mode: "production"`，并配合 `provider_key: "http_json"`（或 `"fapiao_http"`）、HTTPS `settings.base_url` 与 `file:`/`env:` 凭据引用。避免将引用写进日志和源码，服务只在校验/开票时短时读取。

开票行为在真正税务发票提供商适配器配置完成前保持 fail-closed。`local_test` 仅可在测试模式使用并产出可复现的沙箱工件，不得在生产环境选择。生产租户可使用 `http_json`（或 `fapiao_http`）适配器。其 `invoice_provider_configs.settings` 必须包含 HTTPS `base_url`，可选 `issue_path`、`void_path`、`red_letter_path`；凭据引用必须解析为 bearer token。提供商需接受文档化 JSON 请求并返回 `provider_reference`、`invoice_number`，以及可选 `artifact`（包含 `media_type` 与 base64 `content_base64`）。服务会在入库前加密返回的 artifact，并拒绝缺失引用、格式非法、非 HTTPS 端点与生产环境 local-test 提供商。这样既保证厂商接入可见明确，又保留税务提供商合同可替换性。

回调接收端点为
`POST /payments-api/v1/payment-webhooks/{production_gateway_id}`。EPay 回调使用 MD5，Alipay 使用 RSA2，WeChat Pay v3 使用平台 RSA 校验并结合 API-v3 AES-GCM 解密资源，Waffo 使用其配置的 RSA 公钥。每个校验通过的事件都会绑定到网关与商家订单，按入账金额核验，通过提供商事件 ID 去重后进入支付/退款状态机。入站记录在状态变更前会先被“签收”；签收进行中会返回可重试的 503，超过 5 分钟的签收可在进程崩溃后被回收。签收 token 可防止旧 worker 用过时重试覆盖更新。变更前还会校验提供商引用与商家订单/支付身份。未知或不匹配事件保留于收件箱供审计，不会改写任何支付状态。EPay 与 Alipay 成功回调返回其要求的明文 `success`，WeChat 返回 `{"code":"SUCCESS"}`，Waffo 返回 `{"code":"0"}`。

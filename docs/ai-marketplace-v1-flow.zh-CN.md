# AI市场V1集成流程

这是通用 MatchPlane 内核的实现边界。一个包可以描述一个
车辆、服务、财产或任何其他供应类型；内核从不添加域模式。

## 谁连接模型

有三个独立的模型职责：

1. **根平台代理** — 选择活动子路径。它接收有限的叙述并且可以
   仅从服务器提供的白名单中选择 slugs。它的关键是服务器端，其成本是
   由平台承担。它不会提取车辆字段、查询矢量数据库或发布
   一个报价。
2. **垂直/包代理** — 在终端包或包拥有的服务上运行。它
   了解该包的架构、提取配置文件、调用检索/媒体 MCP 工具，以及
   返回带有解释和风险的规范 `offer_id` 参考文献。 root仅验证
   范围、生命周期和权限。
3. **买方/卖方代理** — 外部调用者可以使用相同的 MCP 合约和类型
   `@matchplane/agent-client` SDK。它的模型、工具循环和代币账单都是调用者拥有的。它得到一个
   短暂的一方能力，而不是浏览器会话或平台模型密钥。

根路由器默认接受与 OpenAI 兼容的聊天完成，并且还可以使用母语
服务器边界的 Anthropic Messages 或 GeminiGenerateContent。部署可以将其指向
LiteLLM、Vercel AI Gateway、vLLM、Ollama 或其他兼容网关；特定于提供商的 SDK
留在 Rust 内核之外。参见[`ai-provider-contract.md`](ai-provider-contract.md)。

## 买家流

```text
chat message
  -> Better Auth + scoped party capability
  -> platform.match (root Agent chooses bounded child paths)
  -> marketplace.intent.create / intent.update (one intent, optimistic version)
  -> package Agent updates opaque profile and calls retrieval.query (optional)
  -> root re-reads active canonical offers by offer_id
  -> UI shows at most three offers, reasons and risks
  -> open/save/dismiss/compare -> append-only behavior events
  -> sales.handoff snapshot -> introduction/contact consent -> contact release
```

即使轮廓不完整，第一轮也很有用。后续轮次追加有界
对话上下文和更新意图相同；他们不会为每个人创造一个新的意图
句子。包可以用键入的字段（例如预算或用例）替换不透明的配置文件，
但这些字段仍然是包拥有的 JSON。

## 卖家流程及素材上传

卖家在同一聊天组件中启动。对话创建了 `supply` 意图和
可审查的草案。然后卖家手动完成包裹架构并提交草稿报价；
审核必须先激活它，然后才能匹配。

对于支持媒体的软件包，软件包清单会宣传媒体 MCP 工具（例如
`media.upload`）。聊天 UI 使用根范围的 `POST /api/platform/media/upload` 外观，但是
卖家/包裹代理和子适配器仍然拥有解释和持久性：

1. 将选定的文件/照片发送到包媒体适配器。
2. 适配器验证 MIME/大小，扫描它，将其存储在内容寻址密钥下，然后返回
   不透明的 `attachment_ref` 加上维度/散列。
3. 包代理读取附件并提出模式字段（对于车辆包，此
   可以包括型号、年份、里程、价格和照片）。
4. UI 将提案放置在手动编辑器中。卖家审核、编辑并确认。
5. `marketplace.offer.create` 将包拥有的属性/术语和附件引用存储为
   JSON。根不存储原始二进制或推断字段。
6. 根通过`catalog.upsert`发送规范offer投影；孩子索引它
   仅在根审核转换达到`active`之后。看
   [`catalog-protocol-v1.json`](catalog-protocol-v1.json)。

默认根中继预算为 25 MiB（`MATCHPLANE_MEDIA_MAX_BYTES` 可以降低或提高到
256 MiB 协议上限）。反向代理必须配置相同的 JSON/base64 主体
预算。这是一个有界的兼容路径，而不是无限上传的承诺；大视频
文件应该使用子拥有的直接对象存储适配器。

如果包没有真正的媒体适配器，UI 不得声明本地文件已上传或
已编入索引。卖家仍然可以粘贴已批准的 URL 或使用 JSON 编辑器。此失败关闭规则
防止看似成功的上传产生不可搜索的列表。

## MCP 表面

经过身份验证的 HTTP MCP 外观为 `/api/mcp`。稳定的工具有：

- 路由：`platform.match`、`platform.agent.handoff`、`platform.child.tool`；
- 市场状态：`marketplace.agent.session`、`marketplace.intent.create/update`、
  `marketplace.profile.get/upsert`；
- 反馈和切换：`marketplace.behavior.record`、`marketplace.preferences.list`、
  `marketplace.preference.set`，`marketplace.sales.handoff`；
- 供应和同意：`marketplace.offer.create/match`、`marketplace.demand.match`、
  `marketplace.introduction.*`。
- 包拥有的材质：`media.upload`是可选的，仅在活动时可调用
  清单声明了它，并且部署已配置其 MCP 端点。

`retrieval.query` 是包声明的功能，而不是默认的根实现。根
检索外观验证`matchplane.retrieval/v1`信封，仅转发到活动的
清单批准的端点，并在渲染返回的规范报价之前重新验证它们。

## 具体示例（包拥有的字段）

```json
{
  "narrative": "需要一台适合长途、预算 15 万以内的车",
  "attributes": {
    "category": "vehicle",
    "budget_max_minor": "15000000",
    "use_case": ["long_distance"]
  },
  "terms": { "currency": "CNY", "currency_scale": 2 },
  "attachments": [
    { "attachment_ref": "media://sha256/...", "kind": "image" }
  ]
}
```

上面的 `vehicle` 键是 auto 包提供的示例；他们不属于
根 ABI。不同的包可以使用具有不同属性和术语的相同传输。

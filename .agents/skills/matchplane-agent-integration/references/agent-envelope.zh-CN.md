# 代理信封快速参考

根在 `POST /api/platform/match` 处接受来自 Better Auth 会话的有界叙述。一个
机器集成使用组织拥有的 `mpk_` API 密钥和规范
`x-matchplane-api-key` 标头，目标端点允许。提供者只能看到
列入许可名单的商店元数据；租户/域权限保留在服务器端。

Agent 阶段如下：

```json
{
  "协议": "matchplane.agent/v1",
  “舞台”：“商人”，
  “范围”：{“平台路径”：“/matx-auto”}，
  “意图”：{“叙述”：“...”，“要求”：{}}，
  "skill": "matchplane.matching.v1",
  "allowed_mcp_tools": ["merchant.search", "inventory.search"],
  “预算”： {
    “最大步数”：8，
    “最大输入字符数”：24000，
    “最大输出令牌”：512，
    "cost_bearer": "平台"
  }
}
```

MCP 工具必须返回有界的、可解释的规范引用。工具输出可以提高排名，
但不能授权联系交换、付款、结算或隐藏的跨租户查询。

## 市场能力交换

外部需求或供应代理不会为每个商店创建单独的浏览器帐户。一个
Better Auth组织API key是机器身份；将其绑定到最小的
`marketplace:write` 权限并将 API 密钥元数据 `agentSide` 设置为 `demand`、`supply` 或
@@TOK0代码。通过`/api/mcp` 调用`marketplace.agent.session`（或
`POST /api/marketplace/agent-session`) 与有效的`tenant_id`、`domain_id`、`platform_path`，
并要求方。市场验证商店的规范/遗留路径，范围
组织访问，并在返回短暂（15 分钟）的派对持有者及其
`access_token_expires_at` 截止日期。

仅将该承载用作通用市场 MCP 工具的 `Authorization: Bearer ...`。这
交易所从 API 密钥中派生出参与方身份，因此调用者无法选择参与者 ID；
它也不会返回联系人值，也不会创建浏览器会话。买家和卖家代理均使用
相同的客户类型——该角色只会缩小允许的市场行为范围。所有外部代理
交接和市场呼叫由呼叫者资助；平台回退是一个单独的、明确的
有界路径，并且永远不会默默地向外部代理收费。

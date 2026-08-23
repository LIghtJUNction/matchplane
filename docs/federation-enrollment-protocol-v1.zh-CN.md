# 远程联邦入驻协议 v1

远程平台以一个瞬时邀请令牌和一个 Ed25519 签名清单完成入驻。令牌只用于把请求
绑定到根平台管理员指定的 `tenant/domain/parent`，用于签名证明终点节点对自己的节点
身份和MCP端点负责；两者都不能跳过根管理员的激活审核。

## 签名内容

发送给 `/api/platform/federation/enroll` 的 `enrollment` 对象包含
[`federation-enrollment-protocol-v1.json`](federation-enrollment-protocol-v1.json)定义的
字段。签名输入是下面对象的规范JSON（对象键按UTF-16字典排序排序，队列保持原顺序，
字符串使用 JSON 转义）：

```json
{
  "displayName": "远端平台名称",
  "endpoint": "https://remote.example/mcp",
  "manifest": { "apiVersion": "matchplane.subplatform/v1", "rootApiVersion": "v1", "id": "remote", "slug": "remote" },
  "mcpServerKey": "remote",
  "nodeId": "018f0d5f-8c30-7b46-9f2b-2b0bf28a2ef0",
  "protocol": "matchplane.federation/v1",
  "slug": "remote"
}
```

`publicKey` 是 Ed25519 SPKI DER 的 base64；`signature` 是 64 字节签名的 base64。
签名本身不触发签名输入，防止序列化循环。根会重新计算清单SHA-256，并把清单、
签名、公钥和摘要作为审计记录保存。

## 生命周期

```text
pending → active → degraded
             └────────→ revoked
```

- `pending`：代币已消费，但尚未进入平台树。
- `active`：根管理员激活后，创建本地 Better Auth 组织和 `source_kind=remote` 路由投影。
- `degraded`：健康检查或MCP传输连续失败时的运维状态，不会自动放宽权限。
- `revoked`：取消绑定并禁止必须本地路由；重新入驻生成新token。

运行时调用仍需调用方自己的 `agent:tool` 或 `retrieval:query` API key，以及正确的
`platform_path` 和租户/域范围。 最终承载仅由 root web 的 `tokenEnv` 秘密
引用加载；不会经过浏览器、不会填写清单、不会转发调用方的API密钥。

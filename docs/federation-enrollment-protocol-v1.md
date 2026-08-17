# 远程联邦入驻协议 v1

远程平台以一个一次性邀请 token 和一个 Ed25519 签名清单完成入驻。token 只用于把请求
绑定到根平台管理员指定的 `tenant/domain/parent`，签名用于证明远端节点对自己的 node
identity 和 MCP endpoint 负责；两者都不能跳过根管理员的激活审核。

## 签名内容

发送给 `/api/platform/federation/enroll` 的 `enrollment` 对象包含
[`federation-enrollment-protocol-v1.json`](federation-enrollment-protocol-v1.json) 定义的
字段。签名输入是下面对象的规范 JSON（对象键按 UTF-16 字典序排序，数组保持原顺序，
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

`publicKey` 是 Ed25519 SPKI DER 的 base64；`signature` 是 64 字节签名的 base64。公钥和
签名本身不放进签名输入，防止序列化循环。根会重新计算 manifest SHA-256，并把清单、
签名、公钥和摘要作为审计记录保存。

## 生命周期

```text
pending → active → degraded
             └────────→ revoked
```

- `pending`：token 已消费，但尚未进入平台树。
- `active`：根管理员激活后，创建本地 Better Auth 组织和 `source_kind=remote` 路由投影。
- `degraded`：健康检查或 MCP 传输连续失败时的运维状态，不会自动放宽权限。
- `revoked`：撤销绑定并禁用本地路由；重新入驻必须生成新 token。

运行时调用仍需调用方自己的 `agent:tool` 或 `retrieval:query` API key，以及正确的
`platform_path` 和 tenant/domain scope。远端 bearer 只由 root web 的 `tokenEnv` secret
引用加载；不会经过浏览器、不会写入清单、不会转发调用方的 API key。

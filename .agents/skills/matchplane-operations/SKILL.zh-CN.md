---
名称：比赛飞机操作
描述：通过其统一的 CLI 和只读 MCP 工具安全地操作 MatchPlane。在启动后端服务、检查生产配置、诊断运行状况、验证安装或在部署期间协助操作代理时使用。
---

# 匹配平面操作

优选使用打包的 `matchplane` CLI 来执行操作员和代理操作。继续改变行动
明确、经过验证且可审计；默认情况下，MCP 表面是只读的。

## 安全操作顺序

1. 在启动工作负载之前运行 `matchplane doctor --json` 并修复配置错误。
2. 运行`matchplane status --json` 检查网关、支付和网络运行状况端点。治疗一个
   未完成准备检查作为操作事件，而不是作为绕过身份验证或 TLS 的原因。
3. 使用`matchplane migrate` 应用架构更改。在全新安装中，使用
   `matchplane provision-root --tenant-slug <slug> --tenant-name <name>` 与运营商拥有
   价值观；它仅创建明确请求的租户/域身份，并且从不创建种子
   业务数据。
4. 在 systemd/容器监督下使用 `matchplane serve <service>` 启动一项工作负载。做
   不以 root 身份运行服务或在命令行上传递机密。
5. 对于操作代理，通过 stdio 启动 `matchplane mcp serve`。仅暴露
   `platform.status`、`platform.doctor` 和`platform.health`；永远不要添加执行的工具
   任意 shell 命令或返回秘密值。

## 生产门

生产需要独特的更好的身份验证和服务密钥、HTTPS 起源、PostgreSQL
`sslmode=verify-full`、`rediss://` Valkey、用于 Kafka 工作负载的 Kafka mTLS 以及显式
配置支付/人工智能提供商。只有在每次祖先注册之后，路径才是可路由的
目标不可变注册是`active`。

请参阅 [references/operator-contract.md](references/operator-contract.md) 了解退出代码、JSON 输出、
和部署清单。

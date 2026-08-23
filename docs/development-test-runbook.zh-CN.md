# 开发测试服务器运行手册

这里用于开发、联调和预发布验收。当前托管MatchPlane的服务器属于开发测试环境，
不是生产环境；不要在这里接入真实支付凭据、真实客户资料或未经脱敏的生产数据库。

## 环境边界

`MATCHPLANE_ENVIRONMENT` 是 MatchPlane 的业务安全配置文件，必须显式设置为
`development` 或 `test`。`NODE_ENV=production` 只表示 Next.js 使用优化后的独立版
构建，并不代表平台进入生产模式。

Web systemd 单元不会覆盖 `MATCHPLANE_ENVIRONMENT`；它从共享的
`/etc/matchplane/matchplane.env`和服务独有的env文件读取。开发测试服务器建议使用：

```dotenv
MATCHPLANE_ENVIRONMENT=test
NODE_ENV=production
```

`development` 仅适合环回或本地 Compose。仅在显式设置
`MATCHPLANE_ALLOW_DEMO_BOOTSTRAP=true`时才允许无 SMTP 的首账号引导；公开可访问的测试
服务器也应使用 `MATCHPLANE_ROOT_ADMIN_EMAIL`、SMTP 和 Better Auth 邮箱验证，不宜启用该
演示开关。

## CLI 启动顺序

所有仓库工作负载都通过统一的 `matchplane` CLI 启动。systemd、Container 或本地 shell 只负责
提供环境文件和进程监督，不能绕过 CLI 直接切割服务参数。

```sh
matchplane doctor --json
matchplane initialize
matchplane status --json
matchplane serve gateway
matchplane serve payment-service
matchplane serve event-relay
matchplane serve matcher
matchplane serve projector
matchplane serve vector-worker
matchplane serve federation-hub
matchplane serve subplatform-builder
matchplane serve web
```

不需要某些服务时不要启动它。开发测试环境只能启动Web、网关和数据库；启用子平台
构建、支付或联邦联调时，再启动对应的工作量。

Agent 可以通过 `matchplane mcp serve` 使用串口的 `platform.status`、`platform.doctor`、
`platform.health` 和 `platform.ai.status` 运维工具。它们只返回有界诊断，不返回按键，也
不能代替管理员执行迁移、支付或权限变更。

## 管理员与托管代理联调

1.设置`MATCHPLANE_ROOT_ADMIN_EMAIL`，启动Web并完成Better Auth邮箱验证。
2. 访问`/login?role=platform`，在根平台启动面板初始化根组织。
3. 需要增加管理员时，使用 `matchplane admin-invite --role root-admin` 生成一次性链接。
4.在Web服务端密钥文件配置`MATCHPLANE_ROUTER_AI_URL`、`MATCHPLANE_ROUTER_AI_KEY`、
   `MATCHPLANE_ROUTER_AI_MODEL` 和协议字段；浏览器与外部代理都不能读取provider key。
5. 在平台面板使用"测试连接"，再从买方或卖方聊天框发送一条脱敏需求，确认路由、子平台
   MCP 和结果解释了审计记录。

开发测试可使用本机LiteLLM、vLLM、Ollama或其他OpenAI兼容网关；也可使用已配置
的 Anthropic Messages / GeminiGenerateContent 协议。平台托管代理的代币预算应设置为
测试限额，外部北极/侦察代理仍使用自己的侦察并由调用方承担成本。

## 支付、邮件和数据

- 支付网关、发票和退款全部保留`test`/沙盒模式；切换到生产模式不是开发测试
  验收的一部分。
- 子平台SMTP使用各自的秘密参考，测试服务器不在仓库或数据库保存明文密码。
- 子平台目录、图片和附件使用测试数据；上传前后检查大小、MIME、摘要和机场/域范围。
- 测试完成后只清理明确属于该测试的容器、构建产物和日志，不删除共享系统缓存或其他项目数据。

## 验收命令

在代码仓库中执行轻量检查：

```sh
just package-check
just agent-check
just subplatform-check
just skills-check
```

完整的撰写冒烟测试会创建临时服务和卷，并在退出时清理：

```sh
just smoke
```

测试服务器对外开放前，至少确认`/api/health/web`返回`ok`、未登录的管理API返回
`401`、MCP `tools/list` 只包含已授权工具，并且开发测试环境的日志中没有提供者密钥、
管理员邀请原文或联系人明文。

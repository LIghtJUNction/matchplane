# 匹配平面

[![CI](https://github.com/LIghtJUNction/matchplane/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/LIghtJUNction/matchplane/actions/workflows/ci.yml)
[![Packages](https://github.com/LIghtJUNction/matchplane/actions/workflows/packages.yml/badge.svg)](https://github.com/LIghtJUNction/matchplane/actions/workflows/packages.yml)
[![License: MIT](https://img.shields.io/github/license/LIghtJUNction/matchplane)](LICENSE)

[English](README.md)·[简体中文](README.zh-CN.md)

MatchPlane 是联合人工智能匹配基础设施。 PostgreSQL 拥有订单、预订、
交易、账本条目、事件和审计历史记录；卡夫卡传输持久的事实；瓦尔基持有
仅可重建的低延迟投影。人工智能检索会推荐候选人并且从不提交
贸易。

每个部署都使用相同的递归平台模型：配置的租户有一个显式的
`rootPlatform` 组织，并且安装的平台可以拥有自己的孩子。人工账户使用
更好的身份验证；平台到平台凭证使用具有显式功能的 Better Auth 组织 API 密钥
范围。

打包的 `matchplane` CLI 是公共后端和操作入口点：使用
`matchplane serve <service>` 启动工作负载，`matchplane doctor/status --json` 表示有界
诊断，以及只读 MCP 工具的 `matchplane mcp serve`。 Web 服务的 `/api/mcp`
外观为外部代理公开了经过身份验证的平台和市场工具。这
无依赖`integrations/matchplane-agent-client`包提供相同的调用者资助
内核端的可发布客户端形状和用于多步骤 MCP 的有界本地技能运行器
来电；代理所有者可以将其安装在自己的服务器端运行时中，而无需获取平台令牌
依赖性。

远程平台可以使用`matchplane federation-invite --domain-id <uuid>`或root管理员
面板来生成一次性签名的注册令牌。已提交的远程节点仍为 `pending`
直到 root 管理员激活它；活动节点和嵌入式子平台共享相同的
组织、清单、MCP 允许列表和路径路由模型。

该存储库是一个 Rust 2024 模块化单一存储库，具有可独立部署的服务。根
引擎是领域中立的；每个商店从独立维护的签出或部署中提供自己的清单、UI、
Agent Skill、MCP 工具和可选检索实现。核心仓库不内置或捆绑任何商店实例。

## 先决条件

- Rust 1.97.0（使用 rustup 时由 `rust-toolchain.toml` 自动安装）
- Bun 1.3.14 或更新版本（Next.js Web 依赖锁使用 Bun）
- 仅 1.40.0 或更新版本（存储库任务运行程序）
- Docker 29+ 与 Compose
- `protoc` 35+

## 本地开发

```sh
cp .env.example .env
just compose-config
just dev
just migrate
just smoke
```

核心不提供租户、域、目录、车辆、支付提供商或生产
行政人员。 Local Compose 是一个明确的开发例外：当
`MATCHPLANE_ENVIRONMENT=development` 和 `MATCHPLANE_ALLOW_DEMO_BOOTSTRAP=true`，第一个
帐户可以在没有 SMTP 的情况下进入根工作区，以便操作员可以检查 UI。绝不携带
该标志进入公共部署。
联系交换只使用根 Better Auth 账号中已验证的邮箱或手机。运营方和已安装包都不能定义手填联系方式字段；只有双方明确同意后才会披露。
将 `MATCHPLANE_ROOT_ADMIN_EMAIL` 设置为运营商拥有的地址，然后仅提供身份
你想要安装：

```sh
cargo run --locked -p xtask -- provision-root \
  --tenant-slug <root-slug> \
  --tenant-name <root-name> \
  --domain-slug <first-domain-slug> \
  --domain-name <first-domain-name> \
  --admin-email <operator-email>
```

将返回的根租户分配复制到 Web 服务环境中并
重新启动它。首先打开`/login?role=platform`，创建并验证配置好的算子
帐户，然后从平台就绪面板初始化根组织。仅在之后
该组织存在，您可以从服务器发出一次性管理员 URL（从不
提交或记录）：

```sh
cargo run --locked -p xtask -- admin-invite --role root-admin
```

要从主机更改 root 管理员密码，请使用仅限操作员的 CLI 命令。上面写着
自动保护受保护的主机配置，然后从隐藏提示中读取密码（或
来自带有 `--password-stdin` 的标准输入），永远不要将密码放在命令行参数中，并且
撤销帐户的每个现有会话：

```sh
sudo matchplane passwd
```

打开返回的`/admin/register?token=...&next=...`链接；它使用与每个相同的登录/注册页面
其他帐户，返回到请求的管理员工作区，并仅在 Better Auth 验证后才提升登录用户。当
root 应该在没有子进程的情况下启动；要稍后添加域，请重复使用由 打印的确切 `--tenant-id`
第一次调用并传递新的域标志。省略 `--tenant-id` 会创建一个新的 UUID
而不是隐式选择现有租户。该命令对于匹配值是幂等的并且
拒绝覆盖现有身份。

在 Alpine 官方 CDN 速度较慢的地区，将 `MATCHPLANE_ALPINE_MIRROR` 设置为受信任的 HTTPS
在构建 PostgreSQL 映像之前创建镜像。 Alpine 包签名仍然由
`apk`；将变量留空可保留官方 CDN。

市场 HTTP API 监听 `http://127.0.0.1:8080`；隔离支付API监听
`http://127.0.0.1:8081`。两者都暴露`/health/live`、`/health/ready`和`/metrics`。

响应式买家、卖家和平台工作区位于 `web/`。运行`bun install --cwd web`
接下来是`bun run --cwd web dev`； Next.js 开发服务器监听
`http://127.0.0.1:4173`。生产版本使用 Next 独立服务器并分阶段进行
每个 Linux 软件包中都有 `/usr/share/matchplane/web`；包装好的`matchplane-web.service`即可食用
UI 和 Better Auth 路线。

对于共享开发或测试主机，请使用 [development/test runbook](docs/development-test-runbook.md)。
它将 MatchPlane 配置文件与 Next.js 的优化 `NODE_ENV` 分开，记录了 CLI
启动顺序，并使托管人工智能和支付提供商保持沙盒模式。测试主机不是
生产部署。

通用市场内核支持中立的需求/供应参与者，可解释
建议、同意控制的介绍和单独的有限源参考
支付服务无需假设正在匹配的内容。通过注册参与者
`POST /v1/marketplace/participants` 与 `marketplace_sides`，然后发布不透明
`attributes`/`terms` 由商店或参与者提供。商店包和 Agent 独立构建、部署并由
运营方绑定；核心 Compose 刻意不捆绑任何商店。除非操作员明确设置，否则旧版 HTTP
路由将被禁用：`MATCHPLANE_ENABLE_LEGACY_MARKETPLACE_ADAPTER=true`；新包使用清单声明的通用合同。看
[docs/marketplace-payments.md](docs/marketplace-payments.md) 付款及佣金
边界。

## 质量门

```sh
just check
```

AUR 的包装定义位于 `packaging/` 下（`matchplane-git` 和
`matchplane-bin`)、Ubuntu `.deb` 和 Fedora `.rpm`。该项目是在 MIT 许可证下发布的；
见`docs/adr/0010-project-license.md`。软件包 CI 构建了两个 AUR 变体：Ubuntu `.deb` 和 Fedora
RPM/SRPM 工件；标记版本发布工件，并且当 `AUR_SSH_PRIVATE_KEY` 和
已审核的`AUR_SSH_KNOWN_HOSTS`条目已配置，将`matchplane-git`和`matchplane-bin`推送到
维护者的 AUR 帐户。

Helm 图表故意拒绝在未将 `image.digest` 设置为不可变 SHA-256 的情况下渲染
已发布容器镜像的摘要；可变标签仅作为发布元数据保留。
标记的 CI 版本同时发布 Rust 服务映像和独立的 Next.js/Better Auth Web
图像到 GHCR。 Kubernetes 部署必须提供不可变的摘要和
`matchplane-web-secrets` 包含`better-auth-secret` 和`root-admin-email` 的秘密。

对于单个 Ubuntu 主机，启用前请参阅[production runbook](docs/production-runbook.md)
生产模式。它涵盖了固定的 Kafka 配置文件、运营商管理的联合节点注册、
服务订购、支付登录、备份和 DNS/证书门。

## 建筑学

请参阅[ARCHITECTURE.md](ARCHITECTURE.md) 和`docs/adr/` 中已接受的决定。

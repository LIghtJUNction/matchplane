# MatchPlane

[![CI](https://github.com/LIghtJUNction/matchplane/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/LIghtJUNction/matchplane/actions/workflows/ci.yml)
[![Packages](https://github.com/LIghtJUNction/matchplane/actions/workflows/packages.yml/badge.svg)](https://github.com/LIghtJUNction/matchplane/actions/workflows/packages.yml)
[![License: MIT](https://img.shields.io/github/license/LIghtJUNction/matchplane)](LICENSE)

[English](README.md) · 简体中文

MatchPlane 是联邦式 AI 撮合基础设施。PostgreSQL 负责订单、预订、交易、账本、事件和审计历史；
Kafka 传输持久化事实；Valkey 只保存可重建的低延迟投影。AI 检索只提出候选，不会直接提交交易。

每个部署都使用同一套递归平台模型：配置的租户拥有一个明确的 `rootPlatform` 组织，挂载的平台还可以
拥有自己的子平台。人类账号使用 Better Auth；平台之间的凭据使用带明确 scope 的 Better Auth 组织 API Key。

打包后的 `matchplane` CLI 是统一的后端和运维入口：使用 `matchplane serve <service>` 启动工作负载，
使用 `matchplane doctor/status --json` 执行有边界的诊断，使用 `matchplane mcp serve` 启动只读 MCP 工具。
Web 服务的 `/api/mcp` 门面向外部 Agent 暴露经过认证的平台与 marketplace 工具。无运行时依赖的
`integrations/matchplane-agent-client` 包为买方和卖方内核提供统一的 caller-funded 发布客户端形态，
也提供只能调用已声明 MCP 工具的本地 Skill runner；Agent 所有者可以在自己的服务端运行时安装它，
无需依赖平台 token。

远程平台可以使用 `matchplane federation-invite --domain-id <uuid>` 或根管理员面板生成一次性签名入驻
token。远端提交的节点会先保持 `pending`，只有根管理员激活后才会进入递归平台树；激活节点与内嵌子平台
共用组织、manifest、MCP allowlist 和路径路由模型。

本仓库是使用 Rust 2024 构建的模块化 monorepo，各服务可以独立部署。根引擎保持领域中立；每个垂直领域
都是一个挂载适配器，负责自己的 manifest、UI、Agent Skill、MCP 工具以及可选的检索实现。仓库中的汽车
兼容适配器只用于示例，不属于根平台数据。

## 前置条件

- Rust 1.97.0（使用 rustup 时会由 `rust-toolchain.toml` 自动安装）
- Bun 1.3.14 或更高版本（Next.js Web 依赖使用 Bun lockfile）
- just 1.40.0 或更高版本
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

核心服务不会创建租户、域名、目录、车辆、支付提供商或生产管理员。Local Compose 是明确的开发例外：
当 `MATCHPLANE_ENVIRONMENT=development` 且 `MATCHPLANE_ALLOW_DEMO_BOOTSTRAP=true` 时，首个账号可以在
没有 SMTP 的情况下进入根工作区，以便运营方检查 UI。不要把这个开关带入公开部署。

根联系渠道同样属于运营方配置（`MATCHPLANE_ROOT_CONTACT_FIELDS_JSON`）；挂载包通过 `ui.contactFields`
拥有自己的展示字段。根 UI 不会编译任何垂直领域字段。

将 `MATCHPLANE_ROOT_ADMIN_EMAIL` 设置为运营方持有的邮箱，然后只配置希望挂载的身份：

```sh
cargo run --locked -p xtask -- provision-root \
  --tenant-slug <root-slug> \
  --tenant-name <root-name> \
  --domain-slug <first-domain-slug> \
  --domain-name <first-domain-name> \
  --admin-email <operator-email>
```

将命令返回的根租户配置写入 Web 服务环境并重启。先打开 `/login?role=platform`，创建并验证配置好的运营方
账号，然后从平台就绪面板初始化根组织。只有根组织存在后，才可以在服务器上签发一次性管理员 URL（不要
提交或记录该 URL）：

```sh
cargo run --locked -p xtask -- admin-invite --role root-admin
```

如果需要在服务器上重置根管理员密码，使用仅供运营方使用的 CLI 命令。命令默认通过隐藏输入读取密码，
也可以使用 `--password-stdin` 从 secret manager 接收一行密码；密码不会出现在命令参数中，执行成功后会
撤销该账号已有的全部会话：

```sh
sudo bash -lc 'set -a; . /etc/matchplane/matchplane.env; . /etc/matchplane/services/web.env; set +a; exec /usr/bin/matchplane auth reset-password --email <root-admin-email>'
```

打开返回的 `/admin/register?token=...&next=...` 链接。它使用与其他账号相同的登录/注册页面，验证 Better
Auth 后才会授予 `rootAdmin` 角色，并回到对应的管理员工作区。若根平台一开始不需要子域，可以省略 domain
参数；之后新增域名时，复用第一次命令输出的确切 `--tenant-id` 并传入新的域名参数。省略 `--tenant-id`
会生成新的 UUID，而不会隐式查找已有租户。相同参数重复执行是幂等的；命令会拒绝覆盖已有身份。

如果所在地区访问 Alpine 官方 CDN 较慢，可以在构建 PostgreSQL 镜像前设置可信 HTTPS 镜像：

```sh
export MATCHPLANE_ALPINE_MIRROR=https://example.invalid/alpine
```

Alpine 包签名仍会由 `apk` 校验；留空则继续使用官方 CDN。

Marketplace HTTP API 监听 `http://127.0.0.1:8080`；隔离的支付 API 监听 `http://127.0.0.1:8081`。两者都提供
`/health/live`、`/health/ready` 和 `/metrics`。

响应式买方、卖方和平台工作区位于 `web/`。运行 `bun install --cwd web`，然后运行
`bun run --cwd web dev`；Next.js 开发服务器监听 `http://127.0.0.1:4173`。生产构建使用 Next standalone
server，并在每个 Linux 包中部署到 `/usr/share/matchplane/web`；打包后的 `matchplane-web.service` 负责
提供 UI 和 Better Auth 路由。

领域中立的 marketplace 内核支持需求方/供给方参与者、可解释的推荐、需要同意的撮合引介，以及面向独立
支付服务的有边界来源引用，不预设具体垂直领域。通过带有 `marketplace_sides` 的
`POST /v1/marketplace/participants` 注册参与者，再发布由垂直适配器或参与者提供的不透明
`attributes`/`terms`。`subplatforms/auto` 包只是兼容适配器：它提供自己的 schema 和 UI，不会在干净的
根部署中自动注入。只有运营方明确设置 `MATCHPLANE_ENABLE_LEGACY_MARKETPLACE_ADAPTER=true` 时，旧版
HTTP 路由才会启用；新包使用 manifest 声明的通用合同。支付与佣金边界见
[docs/marketplace-payments.md](docs/marketplace-payments.md)。

## 质量门禁

```sh
just check
```

打包定义位于 `packaging/`，支持 AUR（`matchplane-git` 和 `matchplane-bin`）、Ubuntu `.deb` 以及 Fedora
`.rpm`。项目使用 MIT License；参见 [docs/adr/0010-project-license.md](docs/adr/0010-project-license.md)。
Package CI 会构建两个 AUR 变体、Ubuntu `.deb`、Fedora RPM/SRPM；带标签的发布会构建发布产物，并且在配置
`AUR_SSH_PRIVATE_KEY` 与经过审核的 `AUR_SSH_KNOWN_HOSTS` 后，将 `matchplane-git` 和 `matchplane-bin` 推送
到维护者的 AUR 账号。

Helm chart 在没有设置发布容器不可变 SHA-256 digest 的情况下会拒绝渲染；可变 tag 只保留作发布元数据。
带标签的 CI 发布 Rust 服务镜像和 Next.js/Better Auth standalone Web 镜像到 GHCR。Kubernetes 部署必须
同时提供不可变 digest，以及包含 `better-auth-secret` 和 `root-admin-email` 的 `matchplane-web-secrets`
Secret。

单台 Ubuntu 主机的生产部署请先阅读[生产运行手册](docs/production-runbook.md)，再启用 production 模式。
手册涵盖固定 Kafka profile、运营方管理的联邦节点注册、服务启动顺序、支付接入、备份和 DNS/证书门禁。

## 架构

参见 [ARCHITECTURE.md](ARCHITECTURE.md) 以及已接受的架构决策文档 [docs/adr/](docs/adr/)。

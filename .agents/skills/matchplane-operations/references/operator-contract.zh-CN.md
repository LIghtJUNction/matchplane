# 运营商合约

打包的 CLI 命令专为自动化而设计：

|命令|目的|突变|
| --- | --- | --- |
| `matchplane doctor --json` |验证加载的配置和依赖关系门 |无 |
| `matchplane status --json` |探测网关、支付和 Web 就绪端点 |无 |
| `matchplane migrate` |应用嵌入式 PostgreSQL 迁移 |架构|
| `matchplane initialize` |应用嵌入式 PostgreSQL 迁移；从不创建业务数据|架构|
| `matchplane provision-root --tenant-slug <slug> --tenant-name <name> --admin-email <email>` |创建或验证操作员提供的根身份并打印管理员配置 |租户/域行 |
| `matchplane serve <service>` |在主管下启动一个指定工作负载 |流程|
| `matchplane mcp serve` |运行只读 stdio MCP 操作服务器 |无 |

JSON 输出对于操作代理来说足够稳定：它包含 `ok`、`service`、`url` 和
`error` 字段，绝不是连接字符串、令牌、密码或提供者凭据。退出代码 0
表示所有要求的检查均已通过；非零意味着调用者必须显示失败。

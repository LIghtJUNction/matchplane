# Next-forge 基础建设

MatchPlane 保留了原有 Rust 服务、Better Auth、PostgreSQL 迁移及 Bun web 应用，同时采纳 [Vercel next-forge](https://github.com/vercel/next-forge) 的生产级 monorepo 约定：

- 仓库根目录作为 Bun workspace；
- `turbo.json` 统一管理具备依赖感知的 `build`、`test`、`check`、`dev` 任务；
- 可独立打包部署的 JavaScript workspace 仍保持独立（`web` 与 `integrations/*`）；
- 领域服务仍然是 Rust workspace，由 `just` 与现有 CI 作业统一编排。

这是一次有节制的渐进式接入。next-forge 只是一个 Turborepo 模板，不是认证或交易市场运行时。若将 Better Auth 替换为 Clerk，或将 Rust 领域服务替换为模板中的 Prisma/Stripe 默认实现，会破坏 MatchPlane 的身份与支付边界。新增共用 UI 或服务端包应放在 `packages/*` 下，前提是确实存在真实复用边界；不要为了复刻模板目录结构而仅创建空壳 package。

可通过 `just check` 执行现有生产门禁。若根目录 Turbo CLI 可用，JS 工作区也可通过 `bun run check` 进行检查。

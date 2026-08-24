# 挑战 #11 交付路线图

> 依据 [交付方案规划](bc-4fc74b76) 与 [代码库探索](bc-59e98564) 整理。按 PR 粒度拆分，匹配发布者偏好（小步、可演示）。

## 已完成

- [x] 首页自然语言「帮我找」入口（`155e1a9`）
- [x] 参与指南 + 提交 playbook（`docs/challenge-11-*.zh-CN.md`）
- [x] 登录/商家文案优化（`69c0bee` 及后续）

## 待实现（按优先级）

| # | 分支建议 | 内容 | 为何重要 |
|---|----------|------|----------|
| 1 | `cursor/wechat-login-console-config-897f` | 商城控制台 WeChat OAuth 配置面板（仿 `national-identity-config`） | 挑战明文要求 |
| 2 | `cursor/phone-otp-console-config-897f` | SMS 网关配置面板 + 本地 mock 可演示 | 挑战明文要求 |
| 3 | `cursor/mutual-contact-disclosure-897f` | 双方同意后释放已验证联系方式 | 核心差异化 |
| 4 | `cursor/offline-viewing-lead-stage-897f` | 约看工具 + CRM 阶段 | 线下交易演示 |
| 5 | `cursor/used-car-demo-seed-897f` | `just demo-used-car` 一键种子数据 | 可复现演示 |

## 阻塞项（需凭证，可 mock 演示）

- 真实微信 OAuth：需开放平台审核 → 面板 + mock OIDC 即可演示
- 真实短信：需阿里云/腾讯云 → localhost mock 网关可跑通 OTP 流程
- AI Key：控制台配置 api.lmm.best 兼容网关即可

## 立即动作（Selena）

1. 接受挑战 + 邮件发布者（见 `challenge-11-submission-playbook.zh-CN.md`）
2. Fork → 应用 `/workspace/matchplane-challenge-11.patch.dir/*.patch`
3. 按上表顺序提 PR，每 PR 跑 `cd web && bun run check`

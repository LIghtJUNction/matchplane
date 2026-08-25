# 挑战 #11 提交作战手册（Submission Playbook）

> 平台挑战页：https://api.lmm.best/challenges/11
> 悬赏仓库：https://github.com/LIghtJUNction/matchplane
> 发布者邮箱：lightjunction.me@gmail.com
> 参与指南：`docs/challenge-11-participation.zh-CN.md`
> 悬赏规则全文：仓库外 `docs/open-source-bounties.md`（Open-Source Bounty Playbook）

本手册回答一个问题：**代码已经写好了，如何把它正确地交出去并拿到验收。**
按顺序执行第 1 ～ 4 步即可完成一次合规提交。

## 0. 现状速览

| 项目 | 状态 |
| --- | --- |
| 本地工作分支 | `cursor/challenge-11-participation-897f`（位于 `/workspace/matchplane`） |
| 核心提交 | `155e1a9 feat(web): add hero need prompt for challenge #11 participation` |
| 直接 push 上游 | **失败，HTTP 403**（无 `LIghtJUNction/matchplane` 写权限，属预期） |
| 备用补丁 | `/workspace/matchplane-challenge-11.patch.dir/0001-feat-web-add-hero-need-prompt-for-challenge-11-parti.patch` |

结论：贡献者对上游仓库没有 push 权限，**必须走 Fork + PR 工作流**（见第 3 步）。

## 1. 第一步：在平台接受挑战

依据悬赏规则 §4.1（Accept a Challenge）：

1. 登录 https://api.lmm.best （接受挑战需要 **L1 开发者权限**）。
2. 打开挑战页 https://api.lmm.best/challenges/11 。
3. 点击 **接受挑战（Accept Challenge）**，填写你的 **GitHub 用户名**（不含 `@`，必须与后续提 PR 的账号一致）。
4. 系统会为你锁定一个奖励名额。注意：
   - 同一用户不能重复接受同一悬赏；
   - 发布者不能接受自己的悬赏；
   - 名额有限（本挑战共 5 个名额，先到先得），接受后长期不提交可能被发布者取消并释放名额。

> 接受成功后，挑战状态为 `Accepted`。此时**尚未提交任何证据**，请尽快完成第 2 步的邮件对接。

## 2. 第二步：邮件联系发布者（必做）

挑战规则明确要求：**务必联系发布者，交流设计细节，展示成果。**
收件人：`lightjunction.me@gmail.com`

### 2.1 接受挑战后的对接邮件（模板 A）

```text
收件人: lightjunction.me@gmail.com
主题: [MatchPlane 挑战 #11] 参与确认 — <你的 GitHub 用户名>

您好：

我已在 api.lmm.best 接受挑战 #11（https://api.lmm.best/challenges/11）。

- GitHub 用户名：<你的 GitHub 用户名>
- 平台账号：<你的 api.lmm.best 账号/邮箱>

方案方向简述：
1. 商城首页保持商品优先展示，新增自然语言需求入口（「帮我找」），
   输入内容预填到选货员对话框；
2. 选货员通过工具检索商品（非 RAG）；
3. 覆盖卖车店铺场景与双方同意后的联系方式交换流程。

预计演示方式：<本地运行录屏 / 测试环境 URL>
方便沟通的时间：<例如工作日 19:00–22:00 (UTC+8)>

期待您的反馈，谢谢！

<署名>
```

### 2.2 提交成果时的通知邮件（模板 B）

```text
收件人: lightjunction.me@gmail.com
主题: [MatchPlane 挑战 #11] 成果提交 — <你的 GitHub 用户名>

您好：

挑战 #11 的成果已提交，请查收：

- PR 链接：https://github.com/LIghtJUNction/matchplane/pull/<PR 编号>
- （如有）Issue 链接：https://github.com/LIghtJUNction/matchplane/issues/<Issue 编号>
- 平台提交：已在 api.lmm.best「开源悬赏 → 已接受的挑战」中填写上述链接

改动摘要：
- <一句话说明每个关键改动，例如：首页新增「帮我找」自然语言入口，预填选货员对话框>
- 测试：<新增/更新的测试文件与运行方式，例如 web/src/components/MarketplaceHome.test.tsx>

验收演示：
- <本地启动步骤或测试环境 URL，关键点击路径见 docs/challenge-11-participation.zh-CN.md 第 3 节>

如需调整或补充，请随时告知。谢谢！

<署名>
```

## 3. 第三步：Fork / PR 工作流（直接 push 返回 403 的处理）

### 3.1 为什么 403

`git push origin` 直接推送 `https://github.com/LIghtJUNction/matchplane.git` 返回 403：当前凭据对上游仓库**只有读权限**。这是开源协作的常态——贡献者应推送到自己的 Fork，再向上游发起 PR。

### 3.2 路线 A：把现有本地分支推到 Fork（推荐，当前选定）

本次提交使用 **pashippercode** 账号的 Fork（https://github.com/pashippercode/matchplane）。
PR 走 **`pashippercode:main` → `LIghtJUNction/matchplane:main`**：挑战分支先推到 fork 备份，
再合入 fork 的 `main`，用 `main` 作为 PR head。

```sh
# 1. 在 GitHub 网页上 Fork：打开 https://github.com/LIghtJUNction/matchplane 点击 Fork；
#    或用 pashippercode 已认证的 gh CLI：
gh repo fork LIghtJUNction/matchplane --clone=false

# 2. 添加 fork 远端（HTTPS 需使用 pashippercode 的凭据/PAT，或改用 SSH 地址）
cd /workspace/matchplane
git remote add fork https://github.com/pashippercode/matchplane.git

# 3. 推送工作分支到 fork 备份
git push -u fork cursor/challenge-11-participation-897f

# 4. 合入 fork main 作为 PR head
git fetch fork main
git checkout -B fork-main fork/main
git merge --no-edit cursor/challenge-11-participation-897f
git push fork fork-main:main
```

一键脚本（拉 bundle、推 fork、合 main、开 PR 一步到位）：`ChunchunOwO/api.lmm.best`
分支 `cursor/matchplane-challenge-11-897f` 下 `challenge-11/push-to-fork.sh`。

### 3.3 路线 B：用导出的补丁在全新克隆上重放

适用于换机器、或本地克隆凭据无法替换的情况。补丁已导出在
`/workspace/matchplane-challenge-11.patch.dir/`：

```sh
git clone https://github.com/pashippercode/matchplane.git
cd matchplane
git checkout -b cursor/challenge-11-participation-897f
git am /workspace/matchplane-challenge-11.patch.dir/*.patch
git push -u origin cursor/challenge-11-participation-897f

# 同样要合入 fork main 作为 PR head
git checkout main
git merge --no-edit cursor/challenge-11-participation-897f
git push origin main
```

> 若本地分支后来又有新提交，先重新导出补丁再重放：
> `git -C /workspace/matchplane format-patch origin/main -o /workspace/matchplane-challenge-11.patch.dir`

### 3.4 向上游发起 PR

网页方式：打开

```text
https://github.com/LIghtJUNction/matchplane/compare/main...pashippercode:matchplane:main
```

或命令行：

```sh
gh pr create \
  --repo LIghtJUNction/matchplane \
  --base main \
  --head pashippercode:main \
  --title "挑战11：首页改成「帮我找」、卡片抄了瓜子的作业、后台能配微信和短信登录了" \
  --body-file docs/challenge-11-pr-selected-body.md
```

选定的 PR 标题与正文见 `docs/challenge-11-pr-selected.zh-CN.md`。验收截图（13 张关键页面加
索引 README）在 `docs/challenge-11-screenshots/`，随分支一起提交，PR 正文末段已引用，
评审可直接看图对照验收点。

PR 必须满足悬赏规则 §4.3（Submit Focused Fixes）：

- 只改动实现挑战目标**所需**的文件（提 PR 前可用 `git rebase -i` 剔除与目标无关的提交，例如纯内部文档）；
- 包含有意义的自动化测试、回归覆盖或可验证的验收步骤；
- 如果同时提交了 Issue，PR 描述中必须引用该 Issue（`Closes #N`）；
- PR 必须属于悬赏指定仓库 `LIghtJUNction/matchplane`；
- 同一个 PR 不能重复用于领取奖励。

## 4. 第四步：在平台提交交付证据

依据悬赏规则 §4.4（Submit in System）：

1. 登录 https://api.lmm.best ，进入 **开源悬赏（Open-Source Bounty）→ 已接受的挑战（Accepted Challenges）**。
2. 找到挑战 #11 的卡片，点击提交，填写：
   - **GitHub PR 链接**（本次交付的核心证据）；
   - **GitHub Issue 链接**（如有；至少提供 Issue 或 PR 之一，两者都填最佳）；
   - **完成说明（可选但强烈建议）**：一段话概括改动、测试方式、演示地址/录屏。
3. 系统会校验链接**必须属于悬赏仓库**，并拒绝重复使用同一个 PR。
4. 提交成功后挑战状态变为 `Submitted`，等待发布者人工验收。
5. 同步发送第 2.2 节的模板 B 邮件，主动向发布者展示成果。

## 5. 验收、结算与争议要点

依据悬赏规则 §3.4 / §4.5 / §6：

- **验收通过（Approved）**：奖励从托管余额直接划入你的 api.lmm.best API 余额，单次不可重复发放。本挑战为 5 选 1 发 $500 余额，其余为安慰奖。
- **被拒绝（Rejected）**：不发奖励，但你有 **7 天申诉窗口**；期间奖励与名额保持冻结，发布者无法关闭项目回收资金。争议由第三方管理员依据系统留存的 Issue/PR/提交记录裁决。
- **双向评分**：验收完成后双方互评 1–5 分并留公开评价，影响市场信誉。
- **主动退出**：评审完成前可随时退出，名额释放，但已投入时间不获补偿。
- **失格红线（§10 摘要）**：不可复现/无影响的问题、伪造缺陷、重复 Issue、与悬赏无关或超范围的 PR、纯格式化/机械修改、缺测试不可验证、重复提交同一 PR。

评审口味（来自发布者要求）：**去 AI 味、简洁易用、真实可点、工具检索而非 RAG**。

## 6. 提交前检查清单

- [ ] 已在 https://api.lmm.best/challenges/11 接受挑战，GitHub 用户名与提 PR 账号一致
- [ ] 已发模板 A 邮件完成对接
- [ ] 本地验收路径全部亲自点通（见 `docs/challenge-11-participation.zh-CN.md` 第 3 节）
- [ ] 测试通过（`cd web && bun test` 等，按仓库 README 执行）
- [ ] 分支已推送到 pashippercode fork 并合入 fork `main`（路线 A 或 B）
- [ ] PR 已以 `pashippercode:main` 为 head 向 `LIghtJUNction/matchplane:main` 发起，描述含改动摘要、测试与验收步骤（含 `docs/challenge-11-screenshots/` 截图），diff 只含必要文件
- [ ] 平台「已接受的挑战」中已提交 PR/Issue 链接与完成说明
- [ ] 已发模板 B 邮件展示成果

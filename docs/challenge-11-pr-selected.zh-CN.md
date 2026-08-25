# 选用 PR 文案（9 版中 #2 口语版最无人味）

选定理由：子代理 [PR 文案 #2 口语](bc-9bd438e8-8dbf-5607-a7d7-ac2135828d75) 胜出——像真人跟 light 说话（「我自己看着都难受」），具体可验，无 PR 机器人腔。否决 [PR 文案 #6  conventional](bc-495f6c53-e78d-5c63-913d-adc9b331169d)（「概述/交付/围绕四个评审要点」AI 味最重）。

---

**TITLE:**

```
挑战11：首页改成「帮我找」、卡片抄了瓜子的作业、后台能配微信和短信登录了
```

**BODY:** 见 `docs/challenge-11-pr-selected-body.md`

---

## 推送命令（pashippercode fork，main → main）

Fork 账号：**pashippercode**（https://github.com/pashippercode/matchplane ，需先从上游 Fork）

PR 走 **`pashippercode:main` → `LIghtJUNction/matchplane:main`**：挑战分支先推到 fork 备份，再合入 fork 的 `main`，用 `main` 作为 PR head。

```sh
gh auth login   # 账号 pashippercode
cd matchplane
git push -u origin cursor/challenge-11-participation-897f

# 合入 fork main 作为 PR head
git fetch origin main
git checkout -B main origin/main
git merge --no-edit cursor/challenge-11-participation-897f
git push origin main

gh pr create \
  --repo LIghtJUNction/matchplane \
  --base main \
  --head pashippercode:main \
  --title "挑战11：首页改成「帮我找」、卡片抄了瓜子的作业、后台能配微信和短信登录了" \
  --body-file docs/challenge-11-pr-selected-body.md
```

验收截图随分支一起带上：`docs/challenge-11-screenshots/`（13 张关键页面 + 索引 README），PR 正文末段已引用，评审直接看图即可对照验收点。

一键脚本（含 bundle、合 main、开 PR）：`ChunchunOwO/api.lmm.best` 分支 `cursor/matchplane-challenge-11-897f` 下 `challenge-11/push-to-fork.sh`

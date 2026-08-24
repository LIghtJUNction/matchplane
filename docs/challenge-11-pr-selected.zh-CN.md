# 选用 PR 文案（9 版中 #2 口语版最无人味）

选定理由：子代理 [PR 文案 #2 口语](bc-9bd438e8-8dbf-5607-a7d7-ac2135828d75) 胜出——像真人跟 light 说话（「我自己看着都难受」），具体可验，无 PR 机器人腔。否决 [PR 文案 #6  conventional](bc-495f6c53-e78d-5c63-913d-adc9b331169d)（「概述/交付/围绕四个评审要点」AI 味最重）。

---

**TITLE:**

```
挑战11：首页改成「帮我找」、卡片抄了瓜子的作业、后台能配微信和短信登录了
```

**BODY:** 见 `docs/challenge-11-pr-selected-body.md`

---

## 推送命令（需先 Fork）

```sh
# 1. 在 GitHub 网页 Fork LIghtJUNction/matchplane 到你的账号
# 2. 本地：
cd matchplane
git remote add fork https://github.com/<你的用户名>/matchplane.git
git push -u fork cursor/challenge-11-participation-897f

# 3. 开 PR（把下面 --body-file 换成上面正文）：
gh pr create \
  --repo LIghtJUNction/matchplane \
  --base main \
  --head <你的用户名>:cursor/challenge-11-participation-897f \
  --title "挑战11：首页改成「帮我找」、卡片抄了瓜子的作业、后台能配微信和短信登录了" \
  --body-file docs/challenge-11-pr-selected-body.md
```

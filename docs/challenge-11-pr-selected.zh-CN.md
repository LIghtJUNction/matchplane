# 选用 PR 文案（9 版中 #2 最无人味）

选定理由：像真人给发布者留言，有具体路径，无「赋能/全面/优化」套话，语气平实。

---

**TITLE:**

```
挑战11交付：matchplane 卖车场景能点了
```

**BODY:**

```markdown
light 你好，这版按挑战页要求做的。

首页先看车，右上角「帮我找」填预算能筛商品；聊天里会先问预算和用途，再出卡片，不是瞎编。联系方式只能走账号里验证过的邮箱/手机，双方同意才给。

商城设置里加了微信登录和短信网关的配置界面（没配真实密钥也能用 mock 演示 OTP）。`tools/demo/bootstrap-car-shop-demo.sh` 一键起「星辰二手车行」六台样车。

我本地点过一遍，测试也跑了。你那边要是方便，按 `docs/challenge-11-demo-script.zh-CN.md` 验一下就行。
```

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
  --title "挑战11交付：matchplane 卖车场景能点了" \
  --body-file docs/challenge-11-pr-selected-body.md
```

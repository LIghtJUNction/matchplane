---
名称：《MatchPlane》
颜色：
  背景："未解决"
  表面："--表面"
  文本："未解决"
  主要："--表面"
---

# 设计系统：MatchPlane

## 视觉主题和氛围

- [观察]现有的第一方主题、共享组件和页面源定义了当前的视觉基线。
- [推断置信度=中] 添加新表面时保留观察到的标记词汇、密度和组件约定。

## 调色板和角色

- [观察到] `--surface: rgba(250, 249, 245, 0.86)`
- [观察到] `--surface: rgba(35, 35, 33, 0.9)`
- [观察到] `#141413`
- [观察到] `#353532`
- [观察到] `#6f706a`
- [观察到] `#faf9f5`
- [观察到] `#f0eee6`
- [观察到] `#e8e6dc`
- [已确认] 产品UI使用温暖的象牙色、墨水、仙人掌、橄榄、粘土；避免通用的"科技蓝色"。
- [已确认] 键盘焦点使用烧粘土`--focus: #9f4f35` (light) / `#f1a07d` (dark)，从不使用蓝色作为默认重音。

## 版式规则

- [观察到] `"Avenir Next", "SF Pro Display", "SF Pro Text", ui-sans-serif, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`
- [观察到] `"Avenir Next", "SF Pro Text", ui-sans-serif, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`
- [观察到] `ui-monospace, SFMono-Regular, Menlo, monospace`
- [推断置信度=中] 在引入新尺寸之前，重用现有的字体堆栈并从共享组件中派生层次结构。

## 组件样式

- [观察到] `subplatforms/auto/src/components/BuyerDashboard.tsx`
- [观察到] `subplatforms/auto/src/components/Overlays.tsx`
- [观察到] `subplatforms/auto/src/components/PlatformDashboard.tsx`
- [观察到] `subplatforms/auto/src/components/Primitives.tsx`
- [观察到] `subplatforms/auto/src/components/SellerDashboard.tsx`
- [观察到] `web/src/admin/components/DataTable.tsx`
- [观察到] `web/src/admin/components/StatusCard.tsx`
- [观察到] `web/src/components/BuyerDashboard.tsx`
- [推断置信度=中] 优先选择现有原语和变体而不是页面本地替换。

## 布局原则

- [推断置信度=低] 未检测到命名间隔标记；确认碱基间距节奏。
- [观察]代表页面：`web/app/page.tsx`
- [观察]代表页面：`web/app/[...platformPath]/page.tsx`
- [观察]代表页面：`web/app/about/page.tsx`
- [观察]代表页面：`web/app/admin/page.tsx`
- [观察]代表页面：`web/app/admin/register/page.tsx`
- [观察]代表页面：`web/app/login/page.tsx`
- [推断置信度=中] 匹配代表性页面的密度和对齐节奏。

## 动作与交互

- [推断置信度=低] 未检测到运动标记；在获得交互证据之前，保持过渡受到限制。
- [推断置信度=中] 保留现有基元的可见悬停、聚焦、按下、加载和减少运动行为。

## 辅助功能

- [推断置信度=中] 保留现有基元中存在的语义控制、键盘焦点可见性和非颜色状态提示。
- [推断置信度 = 低] 对比度、触摸目标、文本缩放和简化运动行为需要运行时验证。

## 来源证据和置信度

- [观察]路径：`subplatforms/auto/src/plugin-entry.tsx`
  sha256：`721b034face91ff619c073ff156a484c1ec243bbe3c52cc739e9c28cca9eb982`
  置信度：高
- [观察]路径：`subplatforms/auto/src/styles.css`
  sha256：`ec44a9c928dc62380bf8b3d9e040dbd8abb8611a58d6c9e2ec2d401a15684e9a`
  置信度：高
- [观察]路径：`subplatforms/auto/src/components/BuyerDashboard.tsx`
  sha256：`93e4da5d0aba904f7a0bb050eec00f464e7363a19d247eb2971675298768d30f`
  置信度：高
- [观察]路径：`subplatforms/auto/src/components/Overlays.tsx`
  sha256：`046015b4812f2f3f27f994bcb77051482423e96b6c47fb8d6b5220a04cbebb96`
  置信度：高
- [观察]路径：`subplatforms/auto/src/components/PlatformDashboard.tsx`
  sha256：`ebb59bfcad322c5c13f38aaf8be1d79e8fc689240c5834072aa7831711a28900`
  置信度：高
- [观察]路径：`subplatforms/auto/src/components/Primitives.tsx`
  sha256：`708371b9502bce634525fbf3c0d6399405301078947ea33e689ddc9c09e0acd0`
  置信度：高
- [观察]路径：`subplatforms/auto/src/components/SellerDashboard.tsx`
  sha256：`de33135df1bd05a1c09d9193bcd6c439e1d6dacefa5ff92bdb5f30ae9af5e39b`
  置信度：高
- [观察]路径：`web/app/layout.tsx`
  sha256：`817c90205a92f3e9090607e25ae2cd0a109958f935e88b9f500200b5473693c8`
  置信度：高
- [观察]路径：`web/app/page.tsx`
  sha256：`03c7ab0c0e0ac56c0cb783d16a4c7592599823ebdfeaa132bb64c6bf77cb5177`
  置信度：高
- [观察]路径：`web/app/[...platformPath]/page.tsx`
  sha256：`ce3a1147f3fff7aa522a18a4cf5b35c00a6131bc45e27ddced90845d8325f510`
  置信度：高
- [观察]路径：`web/app/about/page.tsx`
  sha256：`eba8be038b1599d785c6d9591c6b672bda7fc77b0a3ba6c0b3152c14c7373cfe`
  置信度：高
- [观察]路径：`web/app/admin/page.tsx`
  sha256：`2d360b01fb9e4a6e9504f810d0213f9f95653ab2951a6d70316b6b2c7fc9d6b2`
  置信度：高
- [观察]路径：`web/app/admin/register/page.tsx`
  sha256：`2797b3fa847656f9ea1c493922845028f35a9a6bc8dd7fd097245005b26857d3`
  置信度：高
- [观察]路径：`web/app/login/page.tsx`
  sha256：`055488732e9903e02699298766ee94aa85f2fa558477516f7dc2808f87045df1`
  置信度：高
- [观察]路径：`web/app/oauth/consent/page.tsx`
  sha256：`a995481dc4caed00e08fae0f55a0313fcd1df404b8e03687b8ca3326851c78b1`
  置信度：高
- [观察]路径：`web/app/privacy/page.tsx`
  sha256：`f4b822ca7e4ed6321fa7d4c292797706978393c83c9f4ea274074f0428693cfd`
  置信度：高
- [观察]路径：`web/app/register/page.tsx`
  sha256：`13488c6d13751cddddc7e522685739c0d936641560f1b25972a84e245d2d7c61`
  置信度：高
- [观察]路径：`web/app/terms/page.tsx`
  sha256：`2de759eb431f508f50dd2972dfa98c3d5dfb05e41d894b3792ee45a4ae1d3278`
  置信度：高
- [观察]路径：`web/src/App.test.tsx`
  sha256：`73c0f081b4074cedef5839ad1bc2efb7a72677d84d3a6d2613da9007e68f87bb`
  置信度：高
- [观察]路径：`web/src/App.tsx`
  sha256：`e7bdebb3a7103e9722f4552af378116707407206c7ad302abcda8a6c45efaf72`
  置信度：高
- [观察]路径：`web/src/styles.css`
  sha256：`461fbd1e9a1629300f5c919c79c49298f5bed00f2e9bbfdf9f4585cb2b1e82ab`
  置信度：高
- [观察]路径：`web/src/admin/components/DataTable.tsx`
  sha256：`d43c94b7e734756cccc6d74d77a66fbb0e8d0fa6afefe761192b0fc242ab349e`
  置信度：高
- [观察]路径：`web/src/admin/components/StatusCard.tsx`
  sha256：`16b592bca28b61c92b2bf6c5dce4019bc5dd6e4b6f59d727eb0539e766e6e9c4`
  置信度：高
- [观察]路径：`web/src/admin/pages/AIModelsPage.tsx`
  sha256：`64444650780200f413af5de95ec405849fe99ba30477e204f97d0d2414b05611`
  置信度：高
- [观察]路径：`web/src/admin/pages/MerchantsPage.tsx`
  sha256：`92c32679c5da26d43d806672c3fc0eb7cc90fa48e6c47b492596ae22bb9afca0`
  置信度：高
- [观察]路径：`web/src/admin/pages/NotificationsPage.tsx`
  sha256：`3af39079b0a4face270bf70fa50f94c650906074e6f7d0028b2a85ee5e2bd68a`
  置信度：高
- [观察]路径：`web/src/admin/pages/OAuthProvidersPage.tsx`
  sha256：`30619a8b6d2101e474a83d691b9199f2292cec3124471b5d86a6aa3ec1fc2dc5`
  置信度：高
- [观察]路径：`web/src/admin/pages/SecurityPage.tsx`
  sha256：`b23495b076d52d482153ec11039474928d0de2be46c5a01e5769d954a77c32f9`
  置信度：高
- [观察]路径：`web/src/admin/pages/UsersPage.tsx`
  sha256：`13c5bef15b8215270627a920e5a0a052a189da8a4c513ffc7de6aab04b0afcab`
  置信度：高
- [观察]路径：`web/src/auth/AuthLayout.tsx`
  sha256：`1d2de4bc791877e3bf01cf6720370fdee44a26a5ed5ab9b657efc776d3080538`
  置信度：高
- [观察]路径：`web/src/components/BuyerDashboard.tsx`
  sha256：`bf80e9b5e2653ad1e4e29e2ab6204682f06821db46c1bf6f9f08342bc7ec6fcd`
  置信度：高
- [观察]路径：`web/src/components/ContactProfileCard.tsx`
  sha256：`98c7a618b062c50ad0fbaca681b7588cfdc377b1af9ca7095ae6b92328850298`
  置信度：高

## 已知差距和例外

- [推断可信度=中] 在本草案成为项目权威之前，必须审查从实施推断的语义意图。
- [观察到]形状标记`--radius-small: 0.9rem`
- [观察到]形状标记`--radius-medium: 1.35rem`
- [观察到]形状标记`--radius-large: 2rem`
- [观察到]形状标记`--radius-hero: 2.6rem`

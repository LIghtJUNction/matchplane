"use client";

import {
  ArrowLeft,
  ArrowUpRight,
  Bot,
  Network,
  Scale,
  ShieldCheck,
  Sparkles,
  Store,
} from "lucide-react";

import { Brand } from "../../src/components/Primitives";
import { PreferenceControls } from "../../src/components/PreferenceControls";
import { useInterfacePreferences } from "../../src/lib/preferences";

type Locale = "zh" | "en";

const copy = {
  zh: {
    back: "返回商城",
    eyebrow: "MatchPlane 商城",
    title: "说说预算和需求，从真实店铺里挑。",
    lead: "MatchPlane 把一个商城和许多独立店铺连接在一起。顾客无需登录即可浏览、搜索和比价；想联系商家或购买时再创建账号。",
    flowEyebrow: "一次购物的路径",
    flowTitle: "从一句需求，到一组可比较的商品。",
    flow: [
      [
        "01",
        "说出需求",
        "用自己的话描述品类、预算、用途和不能妥协的条件。",
        "demand",
      ],
      [
        "02",
        "理解需求",
        "购物助手整理条件、发现缺失信息，并把搜索范围控制在真实营业店铺内。",
        "agent",
      ],
      [
        "03",
        "检索店铺",
        "商城从平铺的店铺目录中选择相关商家，不暴露内部接口或凭据。",
        "route",
      ],
      [
        "04",
        "比较商品",
        "只展示商家已发布的真实名称、图片、介绍和价格，并计算总价与价差。",
        "supply",
      ],
      [
        "05",
        "联系购买",
        "顾客准备继续时再登录；联系方式仍需双方同意后才会交换。",
        "consent",
      ],
    ] as const,
    principlesEyebrow: "两层商城",
    principlesTitle: "一个商城，许多平等的店铺。",
    principles: [
      [
        Store,
        "店铺地图",
        "每个入驻商家都是商城地图上的一家店铺，没有让顾客迷路的多级平台树。",
      ],
      [
        Network,
        "灵活接入",
        "店铺可以由商城托管，也可以通过受控接口连接自己的商品系统并被商城检索。",
      ],
      [
        ShieldCheck,
        "真实目录",
        "只会推荐已营业店铺中审核发布的商品；价格、图片和商品身份会从商城记录再次校验。",
      ],
      [
        Scale,
        "清楚结算",
        "商城可为不同店铺配置固定租金、成交佣金或混合方案；线上支付保持可选。",
      ],
    ] as const,
    agentEyebrow: "购物助手如何陪你选购",
    agentTitle: "把找货、比较和计算连成一次对话。",
    agentLead:
      "购物助手不会替商家编造商品。它只在真实目录内理解需求、检索店铺、比较候选、解释差异，并把最终决定交给顾客。",
    agentSteps: [
      ["理解", "识别预算、用途、偏好、数量和硬性条件。"],
      ["找店", "从营业店铺中选出可能有货的商家，并限制并发与等待时间。"],
      ["找货", "读取已发布商品，绝不把外部系统的未经校验结果直接展示给顾客。"],
      ["比较", "并排展示图片、规格与价格，计算合计、最低价和价差。"],
      ["连接", "顾客确认后登录并提出联系申请，双方同意后才交换联系方式。"],
    ] as const,
    distributedEyebrow: "开放店铺网络",
    distributedTitle: "店铺可以分布，顾客看到的商城仍然简单。",
    distributedBody:
      "商家可以直接在商城开店，也可以保留自己的系统。商城只维护稳定的店铺身份、公开商品投影、授权与审计，让分布式接入不增加顾客的使用负担。",
    footer: "三次点击品牌标记可再次打开本页",
  },
  en: {
    back: "Back to mall",
    eyebrow: "MatchPlane / AI Mall",
    title: "Tell AI what you need, then choose from real stores.",
    lead: "MatchPlane connects one mall to many independent stores. Guests can browse, search, and compare; an account is needed only when they want to contact a merchant or buy.",
    flowEyebrow: "One shopping journey",
    flowTitle: "From one request to comparable products.",
    flow: [
      [
        "01",
        "Describe the need",
        "Share the category, budget, use case, and non-negotiable constraints.",
        "demand",
      ],
      [
        "02",
        "AI understands",
        "The assistant organizes constraints, asks for missing context, and searches only real open stores.",
        "agent",
      ],
      [
        "03",
        "Search stores",
        "The mall selects relevant merchants from one flat directory without exposing internal credentials.",
        "route",
      ],
      [
        "04",
        "Compare products",
        "Only published names, images, descriptions, and prices are shown, with totals and price gaps calculated.",
        "supply",
      ],
      [
        "05",
        "Contact and buy",
        "Sign in only when ready to continue; contact details still require consent from both sides.",
        "consent",
      ],
    ] as const,
    principlesEyebrow: "Two-layer mall",
    principlesTitle: "One mall, many equal stores.",
    principles: [
      [
        Store,
        "Store map",
        "Every merchant becomes one storefront on a flat map, with no recursive tree for shoppers to navigate.",
      ],
      [
        Network,
        "Flexible integration",
        "A store may be hosted by the mall or connect its own catalog through a bounded interface.",
      ],
      [
        ShieldCheck,
        "Canonical catalog",
        "AI can recommend only reviewed products from open stores; identities, images, and prices are revalidated.",
      ],
      [
        Scale,
        "Clear commerce",
        "The mall can set subscription rent, commission, or hybrid terms while online payment remains optional.",
      ],
    ] as const,
    agentEyebrow: "How AI helps you shop",
    agentTitle:
      "Connect discovery, comparison, and calculation in one conversation.",
    agentLead:
      "The shopping assistant never invents products for merchants. It works within the real catalog, explains comparisons, and leaves the final choice to the shopper.",
    agentSteps: [
      [
        "Understand",
        "Identify budget, use case, preferences, quantity, and hard constraints.",
      ],
      [
        "Find stores",
        "Select likely merchants from the open directory under bounded concurrency and timeouts.",
      ],
      [
        "Find products",
        "Read published products and revalidate anything returned by an external store.",
      ],
      [
        "Compare",
        "Place images, specifications, and prices side by side and calculate totals and gaps.",
      ],
      [
        "Connect",
        "Ask the shopper to sign in, then exchange contact details only after both sides agree.",
      ],
    ] as const,
    distributedEyebrow: "Open store network",
    distributedTitle: "Stores can be distributed while the mall stays simple.",
    distributedBody:
      "Merchants can open a hosted store or keep their own system. The mall maintains a stable store identity, a public catalog projection, authorization, and audit without exposing infrastructure complexity to shoppers.",
    footer: "Click the brand mark three times to open this page again",
  },
} satisfies Record<Locale, object>;

export default function AboutPage() {
  const { theme, locale, setTheme, setLocale } = useInterfacePreferences();
  const text = copy[locale];

  return (
    <main className="architecture-page">
      <header className="architecture-header">
        <Brand homeHref="/" />
        <div className="architecture-header-actions">
          <PreferenceControls
            theme={theme}
            locale={locale}
            onThemeChange={setTheme}
            onLocaleChange={setLocale}
          />
          <a className="architecture-back" href="/">
            <ArrowLeft size={16} aria-hidden="true" />
            {text.back}
          </a>
        </div>
      </header>

      <section className="architecture-hero">
        <p className="architecture-eyebrow">
          <Sparkles size={15} aria-hidden="true" />
          {text.eyebrow}
        </p>
        <h1>{text.title}</h1>
        <p className="architecture-lead">{text.lead}</p>
      </section>

      <section
        className="architecture-section"
        aria-labelledby="architecture-flow-title"
      >
        <p className="architecture-eyebrow">{text.flowEyebrow}</p>
        <h2 id="architecture-flow-title">{text.flowTitle}</h2>
        <ol className="architecture-waterfall">
          {text.flow.map(([number, title, body, tone]) => (
            <li
              className={`architecture-waterfall-card tone-${tone}`}
              key={number}
            >
              <span className="architecture-step-number">{number}</span>
              <div>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section
        className="architecture-section architecture-section-split"
        aria-labelledby="architecture-principles-title"
      >
        <div>
          <p className="architecture-eyebrow">{text.principlesEyebrow}</p>
          <h2 id="architecture-principles-title">{text.principlesTitle}</h2>
        </div>
        <div className="architecture-principles-grid">
          {text.principles.map(([Icon, title, body]) => (
            <article className="architecture-principle" key={title}>
              <span>
                <Icon size={19} strokeWidth={1.7} aria-hidden="true" />
              </span>
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section
        className="architecture-section architecture-agent-section"
        aria-labelledby="architecture-agent-title"
      >
        <div className="architecture-agent-intro">
          <p className="architecture-eyebrow">
            <Bot size={15} aria-hidden="true" />
            {text.agentEyebrow}
          </p>
          <h2 id="architecture-agent-title">{text.agentTitle}</h2>
          <p>{text.agentLead}</p>
        </div>
        <ol className="architecture-agent-steps">
          {text.agentSteps.map(([title, body], index) => (
            <li key={title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section
        className="architecture-section architecture-distributed"
        aria-labelledby="architecture-distributed-title"
      >
        <p className="architecture-eyebrow">
          <Network size={15} aria-hidden="true" />
          {text.distributedEyebrow}
        </p>
        <h2 id="architecture-distributed-title">{text.distributedTitle}</h2>
        <p>{text.distributedBody}</p>
        <a className="architecture-open-link" href="/">
          <ArrowUpRight size={17} aria-hidden="true" />
          {text.back}
        </a>
      </section>

      <footer className="architecture-footer">{text.footer}</footer>
    </main>
  );
}

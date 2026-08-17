"use client";

import { ArrowLeft, ArrowUpRight, Bot, GitBranch, Layers3, Network, ShieldCheck, Sparkles } from "lucide-react";

import { Brand } from "../../src/components/Primitives";
import { PreferenceControls } from "../../src/components/PreferenceControls";
import { useInterfacePreferences } from "../../src/lib/preferences";

type Locale = "zh" | "en";

const copy = {
  zh: {
    back: "返回平台",
    eyebrow: "MatchPlane / Architecture",
    title: "让需求沿着平台树，找到真正合适的供给。",
    lead: "MatchPlane 是一个通用的、可互联的 Agent 撮合内核。平台不替商家定义商品，也不把交易锁在单一商城里；它只负责理解、路由、记录同意，并把双方安全地交给彼此。",
    flowEyebrow: "一条需求的路径",
    flowTitle: "从一句话，到一次真实连接。",
    flow: [
      ["01", "提出需求", "买方或需求方用自己的话描述目标、边界和不能妥协的条件。", "demand"],
      ["02", "Agent 理解", "Agent 把自然语言整理成可追踪的意图，主动补齐缺失条件，而不是让人填写复杂表格。", "agent"],
      ["03", "选择平台", "路由 Agent 在已激活的平台树中选择最相关的子平台，并受预算、权限和超时约束。", "route"],
      ["04", "寻找供给", "子平台使用自己的检索、MCP 工具或内部 Agent，返回可解释的候选供给。", "supply"],
      ["05", "确认连接", "只有双方明确同意，平台才交换联系方式；线下见面和平台外成交也保留审计记录。", "consent"],
    ] as const,
    principlesEyebrow: "平台互联",
    principlesTitle: "每个平台独立，但不孤立。",
    principles: [
      [Network, "递归平台树", "根平台可以挂载任意子平台；子平台也能继续连接下级平台。一次部署内嵌多个平台，不需要为每个平台开一个进程。"],
      [GitBranch, "稳定接口", "平台之间通过 manifest、能力声明和标准 API 交换上下文。领域字段由平台自己定义，核心只理解需求、供给、介绍与同意。"],
      [ShieldCheck, "边界清晰", "身份、权限、审计和撮合状态由根平台托管；商品数据、向量检索和行业规则由拥有数据的平台负责。"],
      [Layers3, "分布式协作", "平台可以在不同组织、服务器和网络边界运行，通过授权能力互联。中心平台负责路由，不占有所有供给数据。"],
    ] as const,
    agentEyebrow: "Agent 如何撮合",
    agentTitle: "把复杂判断拆成可追踪的几步。",
    agentLead: "Agent 不是一个替商家说话的 Bot。它是受约束的协调者：理解意图、调用工具、比较候选、解释选择，并在关键节点把决定权交还给人。",
    agentSteps: [
      ["理解", "识别目标、预算、时间、地点、偏好和硬约束。"],
      ["路由", "在平台树中逐层筛选，不把同一条需求无边界广播给所有节点。"],
      ["检索", "调用子平台自己的数据库、向量库、MCP 和行业技能，返回证据而不是凭空推荐。"],
      ["协商", "让需求方和供给方补充信息、调整条件，并保留每次变化的上下文。"],
      ["同意", "双方确认后才创建介绍和联系方式交换，平台可按配置记录成交、退款或线下结果。"],
    ] as const,
    distributedEyebrow: "去中心化撮合",
    distributedTitle: "连接可以分布，规则仍然清楚。",
    distributedBody: "MatchPlane 不要求所有供给都搬到根平台。每个子平台拥有自己的数据和检索策略，根平台提供身份、能力授权、路由和可验证的交易状态。平台之间可以互为根与子，形成开放的协作网络。",
    footer: "三次点击品牌标记可再次打开本页",
  },
  en: {
    back: "Back to platform",
    eyebrow: "MatchPlane / Architecture",
    title: "Let every need travel the platform tree to the right supply.",
    lead: "MatchPlane is a generic, interoperable Agent matching core. It does not define a merchant's catalog or trap a transaction in one marketplace. It understands, routes, records consent, and safely brings people together.",
    flowEyebrow: "One request's path",
    flowTitle: "From one sentence to a real connection.",
    flow: [
      ["01", "State the need", "A buyer or requester describes the goal, boundaries, and non-negotiables in their own words.", "demand"],
      ["02", "Agent understands", "The Agent turns natural language into a traceable intent and asks for missing constraints instead of a long form.", "agent"],
      ["03", "Choose a platform", "The routing Agent selects relevant active subplatforms within budget, permission, and deadline limits.", "route"],
      ["04", "Find supply", "A subplatform uses its own retrieval, MCP tools, or Agent to return explainable candidates.", "supply"],
      ["05", "Confirm the connection", "Contact details are exchanged only after explicit consent; offline meetings and outcomes remain auditable.", "consent"],
    ] as const,
    principlesEyebrow: "Interoperability",
    principlesTitle: "Independent platforms, one connected network.",
    principles: [
      [Network, "Recursive platform tree", "A root platform can mount any number of children, and children can connect to their own descendants without spawning a process per platform."],
      [GitBranch, "Stable contracts", "Platforms exchange context through manifests, capability declarations, and stable APIs. Domain fields stay with the platform."],
      [ShieldCheck, "Clear boundaries", "Identity, permission, audit, and matching state live in the root. Catalogs, vector search, and domain rules stay with their owners."],
      [Layers3, "Distributed collaboration", "Platforms may run across organizations, servers, and network boundaries through scoped capabilities. The root routes; it does not own every listing."],
    ] as const,
    agentEyebrow: "How the Agent matches",
    agentTitle: "Break complex judgment into traceable steps.",
    agentLead: "The Agent is not a Bot speaking for merchants. It is a bounded coordinator: understanding intent, calling tools, comparing candidates, explaining choices, and returning decisions to people.",
    agentSteps: [
      ["Understand", "Identify goals, budget, timing, location, preferences, and hard constraints."],
      ["Route", "Filter through the platform tree without broadcasting every request to every node."],
      ["Retrieve", "Call each subplatform's database, vector store, MCP tools, and skills for evidence-backed options."],
      ["Negotiate", "Let both sides add context, adjust conditions, and preserve the conversation history."],
      ["Consent", "Create an introduction and exchange contact only after both sides agree; outcomes can be recorded."],
    ] as const,
    distributedEyebrow: "Decentralized matching",
    distributedTitle: "Connections can be distributed while rules stay clear.",
    distributedBody: "MatchPlane does not require every offer to move into the root platform. Subplatforms own their data and retrieval strategy; the root provides identity, capability authorization, routing, and verifiable transaction state. Platforms can become roots or children of one another.",
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
          <PreferenceControls theme={theme} locale={locale} onThemeChange={setTheme} onLocaleChange={setLocale} />
          <a className="architecture-back" href="/"><ArrowLeft size={16} aria-hidden="true" />{text.back}</a>
        </div>
      </header>

      <section className="architecture-hero">
        <p className="architecture-eyebrow"><Sparkles size={15} aria-hidden="true" />{text.eyebrow}</p>
        <h1>{text.title}</h1>
        <p className="architecture-lead">{text.lead}</p>
      </section>

      <section className="architecture-section" aria-labelledby="architecture-flow-title">
        <p className="architecture-eyebrow">{text.flowEyebrow}</p>
        <h2 id="architecture-flow-title">{text.flowTitle}</h2>
        <ol className="architecture-waterfall">
          {text.flow.map(([number, title, body, tone]) => (
            <li className={`architecture-waterfall-card tone-${tone}`} key={number}>
              <span className="architecture-step-number">{number}</span>
              <div><h3>{title}</h3><p>{body}</p></div>
            </li>
          ))}
        </ol>
      </section>

      <section className="architecture-section architecture-section-split" aria-labelledby="architecture-principles-title">
        <div>
          <p className="architecture-eyebrow">{text.principlesEyebrow}</p>
          <h2 id="architecture-principles-title">{text.principlesTitle}</h2>
        </div>
        <div className="architecture-principles-grid">
          {text.principles.map(([Icon, title, body]) => (
            <article className="architecture-principle" key={title}>
              <span><Icon size={19} strokeWidth={1.7} aria-hidden="true" /></span>
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="architecture-section architecture-agent-section" aria-labelledby="architecture-agent-title">
        <div className="architecture-agent-intro">
          <p className="architecture-eyebrow"><Bot size={15} aria-hidden="true" />{text.agentEyebrow}</p>
          <h2 id="architecture-agent-title">{text.agentTitle}</h2>
          <p>{text.agentLead}</p>
        </div>
        <ol className="architecture-agent-steps">
          {text.agentSteps.map(([title, body], index) => (
            <li key={title}><span>{String(index + 1).padStart(2, "0")}</span><div><h3>{title}</h3><p>{body}</p></div></li>
          ))}
        </ol>
      </section>

      <section className="architecture-section architecture-distributed" aria-labelledby="architecture-distributed-title">
        <p className="architecture-eyebrow"><Network size={15} aria-hidden="true" />{text.distributedEyebrow}</p>
        <h2 id="architecture-distributed-title">{text.distributedTitle}</h2>
        <p>{text.distributedBody}</p>
        <a className="architecture-open-link" href="/"><ArrowUpRight size={17} aria-hidden="true" />{text.back}</a>
      </section>

      <footer className="architecture-footer">{text.footer}</footer>
    </main>
  );
}

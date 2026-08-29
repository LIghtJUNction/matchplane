"use client";

import { ArrowLeft, ArrowUpRight } from "lucide-react";

import { useInterfacePreferences } from "../lib/preferences";
import { PreferenceControls } from "./PreferenceControls";
import { Brand } from "./Primitives";

type Locale = "zh" | "en";

const OPEN_STORE_HREF = `/login?next=${encodeURIComponent("/?stores=1")}`;

const copy = {
  zh: {
    back: "返回商城",
    eyebrow: "如何选购",
    title: "说出需求，从真实店铺里挑。",
    lead: "MatchPlane 是一个商城加许多独立店铺。浏览、搜索和比价不必登录；联系商家或购买时再创建账号。",
    primary: "去首页说说需求",
    stepsEyebrow: "一次购物",
    stepsTitle: "从一句话到可比较的商品。",
    steps: [
      ["01", "说出需求", "用自己的话写品类、预算、用途和不能让步的条件。"],
      ["02", "助手检索", "购物助手只在已营业店铺里找，不会编造未上架的商品。"],
      ["03", "比较结果", "看到的是商家已发布的名称、图片、介绍和价格。"],
      ["04", "准备再登录", "想联系或下单时再登录；联系方式仍需双方同意后才交换。"],
    ] as const,
    rolesEyebrow: "谁在做什么",
    shopperTitle: "顾客",
    shopperBody: "公开浏览和助手检索不需要账号。收藏、联系店铺和购买才会要求登录。",
    merchantTitle: "店主",
    merchantBody: "登录后可以开店、填写商品并上传图片。商品经过商城审核后才会出现在搜索和商品卡里。",
    merchantAction: "登录后开店",
    emptyEyebrow: "目录从空开始",
    emptyTitle: "平台不预置商品。",
    emptyBody:
      "没有已发布商品时，首页会显示空状态。商品只来自店主提交并审核通过的真实资料。",
    legalTerms: "用户协议",
    legalPrivacy: "隐私政策",
  },
  en: {
    back: "Back to mall",
    eyebrow: "How shopping works",
    title: "Tell the mall what you need, then pick from real stores.",
    lead: "MatchPlane is one mall with many independent stores. Browse, search, and compare without an account; sign in only to contact a merchant or buy.",
    primary: "Describe a need on the home page",
    stepsEyebrow: "One shopping path",
    stepsTitle: "From one request to comparable products.",
    steps: [
      [
        "01",
        "Describe the need",
        "Say the category, budget, use, and anything you will not compromise on.",
      ],
      [
        "02",
        "The assistant searches",
        "It looks only inside open stores and does not invent unpublished products.",
      ],
      [
        "03",
        "Compare results",
        "You see published names, images, descriptions, and prices from merchants.",
      ],
      [
        "04",
        "Sign in when ready",
        "Create an account to contact or buy. Contact details still need consent from both sides.",
      ],
    ] as const,
    rolesEyebrow: "Who does what",
    shopperTitle: "Shoppers",
    shopperBody:
      "Public browsing and assistant search do not need an account. Saving, contacting a store, and buying do.",
    merchantTitle: "Store owners",
    merchantBody:
      "Sign in to open a store, enter product details, and upload images. Listings appear in search only after mall review.",
    merchantAction: "Sign in to open a store",
    emptyEyebrow: "Catalogs start empty",
    emptyTitle: "The mall does not seed products.",
    emptyBody:
      "The home page shows an empty state until a merchant publishes reviewed products. Nothing is copied from third-party catalogues.",
    legalTerms: "Terms",
    legalPrivacy: "Privacy",
  },
} satisfies Record<Locale, object>;

export function HowItWorksPage() {
  const {
    theme,
    locale,
    palette,
    textSize,
    setTheme,
    setLocale,
    setPalette,
    setTextSize,
  } = useInterfacePreferences();
  const text = copy[locale];

  return (
    <main className="how-page">
      <header className="how-page-header">
        <Brand homeHref="/" />
        <div className="how-page-header-actions">
          <PreferenceControls
            theme={theme}
            locale={locale}
            palette={palette}
            textSize={textSize}
            onThemeChange={setTheme}
            onLocaleChange={setLocale}
            onPaletteChange={setPalette}
            onTextSizeChange={setTextSize}
          />
          <a className="how-page-back" href="/">
            <ArrowLeft size={16} aria-hidden="true" />
            {text.back}
          </a>
        </div>
      </header>

      <section className="how-page-hero" aria-labelledby="how-page-title">
        <p className="how-page-eyebrow">{text.eyebrow}</p>
        <h1 id="how-page-title">{text.title}</h1>
        <p className="how-page-lead">{text.lead}</p>
        <a className="how-page-primary" href="/">
          {text.primary}
          <ArrowUpRight size={17} aria-hidden="true" />
        </a>
      </section>

      <section className="how-page-section" aria-labelledby="how-page-steps-title">
        <p className="how-page-eyebrow">{text.stepsEyebrow}</p>
        <h2 id="how-page-steps-title">{text.stepsTitle}</h2>
        <ol className="how-page-steps">
          {text.steps.map(([number, title, body]) => (
            <li key={number}>
              <span className="how-page-step-number">{number}</span>
              <div>
                <h3>{title}</h3>
                <p>{body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="how-page-section" aria-labelledby="how-page-roles-title">
        <p className="how-page-eyebrow">{text.rolesEyebrow}</p>
        <h2 id="how-page-roles-title" className="visually-hidden">
          {text.rolesEyebrow}
        </h2>
        <div className="how-page-roles">
          <article>
            <h3>{text.shopperTitle}</h3>
            <p>{text.shopperBody}</p>
          </article>
          <article>
            <h3>{text.merchantTitle}</h3>
            <p>{text.merchantBody}</p>
            <a className="how-page-secondary" href={OPEN_STORE_HREF}>
              {text.merchantAction}
            </a>
          </article>
        </div>
      </section>

      <section
        className="how-page-section how-page-empty"
        aria-labelledby="how-page-empty-title"
      >
        <p className="how-page-eyebrow">{text.emptyEyebrow}</p>
        <h2 id="how-page-empty-title">{text.emptyTitle}</h2>
        <p>{text.emptyBody}</p>
      </section>

      <footer className="how-page-footer">
        <a href="/terms">{text.legalTerms}</a>
        <a href="/privacy">{text.legalPrivacy}</a>
      </footer>
    </main>
  );
}

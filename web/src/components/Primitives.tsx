"use client";

import { useRef } from "react";
import type { ComponentType, MouseEvent, ReactNode } from "react";
import { ArrowUpRight, ChevronRight, Sparkles } from "lucide-react";
import { motion } from "motion/react";

import type { Accent, ActivityItem } from "../types";

export const spring = { type: "spring" as const, bounce: 0, duration: 0.38 };
export const momentumSpring = { type: "spring" as const, bounce: 0.18, duration: 0.4 };

export function Brand({ label = "MatchPlane", homeHref = "#top" }: { label?: string; homeHref?: string }) {
  const clickState = useRef({ count: 0, lastAt: 0 });

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    const now = Date.now();
    if (now - clickState.current.lastAt > 1_200) clickState.current.count = 0;
    clickState.current.lastAt = now;
    clickState.current.count += 1;
    if (clickState.current.count >= 3) {
      event.preventDefault();
      clickState.current.count = 0;
      window.location.assign("/about");
    }
  };

  return (
    <a className="brand" href={homeHref} aria-label={`${label} 首页`} onClick={handleClick}>
      <span className="brand-mark" aria-hidden="true">
        <span />
        <span />
      </span>
      <span>{label}</span>
    </a>
  );
}

export function IconButton({
  label,
  children,
  onClick,
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <motion.button
      className="icon-button"
      type="button"
      aria-label={label}
      onClick={onClick}
      whileTap={{ scale: 0.92 }}
      transition={spring}
    >
      {children}
    </motion.button>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  titleId,
  action,
  onAction,
}: {
  eyebrow?: string;
  title: string;
  titleId?: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="section-heading">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h2 id={titleId}>{title}</h2>
      </div>
      {action ? (
        <button className="text-action" type="button" onClick={onAction}>
          {action}
          <ChevronRight size={17} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export function MetricCard({
  icon: Icon,
  label,
  value,
  detail,
  tone = "plain",
}: {
  icon: ComponentType<{ size?: number; strokeWidth?: number; "aria-hidden"?: boolean }>;
  label: string;
  value: string;
  detail: string;
  tone?: "plain" | "cactus" | "clay" | "heather";
}) {
  return (
    <motion.article className={`metric-card metric-${tone}`} layout transition={spring}>
      <span className="metric-icon">
        <Icon size={19} strokeWidth={1.8} aria-hidden={true} />
      </span>
      <p>{label}</p>
      <strong>{value}</strong>
      <small>{detail}</small>
    </motion.article>
  );
}

export function ListingVisual({
  accent,
  compact = false,
  label,
  imageUrl,
  alt = "",
}: {
  accent: Accent;
  compact?: boolean;
  label?: string;
  imageUrl?: string;
  alt?: string;
}) {
  return (
    <div className={`listing-visual accent-${accent}${compact ? " listing-compact" : ""}${imageUrl ? " has-product-image" : ""}`}>
      {imageUrl ? (
        <img src={imageUrl} alt={alt} loading={compact ? "lazy" : "eager"} decoding="async" />
      ) : (
        <>
          <span className="organic-shape organic-one" />
          <span className="organic-shape organic-two" />
          <Sparkles aria-hidden="true" strokeWidth={1.45} />
        </>
      )}
      {label ? <span className="visual-label">{label}</span> : null}
    </div>
  );
}

export function ActivityList({ items }: { items: ActivityItem[] }) {
  return (
    <ol className="activity-list">
      {items.map((item) => (
        <li key={`${item.title}-${item.time}`}>
          <span className={`activity-dot tone-${item.tone}`} aria-hidden="true" />
          <div>
            <strong>{item.title}</strong>
            <p>{item.detail}</p>
          </div>
          <time>{item.time}</time>
        </li>
      ))}
    </ol>
  );
}

export function InlineLink({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button className="inline-link" type="button" onClick={onClick}>
      {children}
      <ArrowUpRight size={15} aria-hidden="true" />
    </button>
  );
}

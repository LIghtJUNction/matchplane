"use client";

import { useRef } from "react";
import type { MouseEvent } from "react";
import { ChevronRight, Sparkles } from "lucide-react";

import type { Accent } from "../types";

export const spring = { type: "spring" as const, bounce: 0, duration: 0.38 };
export function Brand({
  label = "MatchPlane",
  logoUrl,
  homeHref = "#top",
}: {
  label?: string;
  logoUrl?: string;
  homeHref?: string;
}) {
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
    <a
      className="brand"
      href={homeHref}
      aria-label={`${label} 首页`}
      onClick={handleClick}
    >
      <span className="brand-mark" aria-hidden="true">
        {logoUrl ? (
          <img src={logoUrl} alt="" />
        ) : (
          <>
            <span />
            <span />
          </>
        )}
      </span>
      <span>{label}</span>
    </a>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  titleId,
  action,
  actionClassName,
  onAction,
}: {
  eyebrow?: string;
  title: string;
  titleId?: string;
  action?: string;
  actionClassName?: string;
  onAction?: () => void;
}) {
  return (
    <div className="section-heading">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h2 id={titleId}>{title}</h2>
      </div>
      {action ? (
        <button
          className={`text-action${actionClassName ? ` ${actionClassName}` : ""}`}
          type="button"
          onClick={onAction}
        >
          {action}
          <ChevronRight size={17} aria-hidden="true" />
        </button>
      ) : null}
    </div>
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
    <div
      className={`listing-visual accent-${accent}${compact ? " listing-compact" : ""}${imageUrl ? " has-product-image" : ""}`}
    >
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={alt}
          loading={compact ? "lazy" : "eager"}
          decoding="async"
        />
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

"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

import styles from "./AssistantLiquidIndicator.module.css";

export type AssistantLiquidActivity = "shopping" | "store" | "seller";

type LiquidComponent = typeof import("liquid-gooey")["Liquid"];
type Point = { x: number; y: number };

const paths: Record<
  AssistantLiquidActivity,
  { apart: readonly [Point, Point]; merged: readonly [Point, Point] }
> = {
  shopping: {
    apart: [
      { x: -5, y: 0 },
      { x: 5, y: 0 },
    ],
    merged: [
      { x: -1.25, y: 0 },
      { x: 1.25, y: 0 },
    ],
  },
  store: {
    apart: [
      { x: -4, y: -3 },
      { x: 4, y: 3 },
    ],
    merged: [
      { x: -1, y: -0.75 },
      { x: 1, y: 0.75 },
    ],
  },
  seller: {
    apart: [
      { x: 0, y: -5 },
      { x: 0, y: 5 },
    ],
    merged: [
      { x: 0, y: -1.25 },
      { x: 0, y: 1.25 },
    ],
  },
};

function useMotionGate(rootRef: RefObject<HTMLDivElement | null>) {
  const [reducedMotion, setReducedMotion] = useState(true);
  const [pageVisible, setPageVisible] = useState(false);
  const [inView, setInView] = useState(true);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const sync = () => setPageVisible(document.visibilityState !== "hidden");
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      setInView(entry?.isIntersecting ?? true);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [rootRef]);

  return !reducedMotion && pageVisible && inView;
}

export function AssistantLiquidIndicator({
  activity,
}: {
  activity: AssistantLiquidActivity;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [Liquid, setLiquid] = useState<LiquidComponent | null>(null);
  const [phase, setPhase] = useState(false);
  const enhancementAllowed = useMotionGate(rootRef);

  useEffect(() => {
    if (
      !enhancementAllowed ||
      Liquid !== null ||
      typeof ResizeObserver === "undefined" ||
      typeof window.requestAnimationFrame !== "function" ||
      typeof window.cancelAnimationFrame !== "function"
    ) {
      return;
    }

    let cancelled = false;
    void import("liquid-gooey")
      .then((module) => {
        if (!cancelled) setLiquid(() => module.Liquid);
      })
      .catch(() => {
        // The visual enhancement is optional; the static marker remains.
      });
    return () => {
      cancelled = true;
    };
  }, [Liquid, enhancementAllowed]);

  const enhanced = Liquid !== null && enhancementAllowed;

  useEffect(() => {
    if (!enhanced) return;
    const interval = window.setInterval(() => {
      setPhase((current) => !current);
    }, 720);
    return () => window.clearInterval(interval);
  }, [enhanced]);

  const points = paths[activity];
  const positions = enhanced && phase ? points.merged : points.apart;

  return (
    <div
      ref={rootRef}
      className={styles.frame}
      aria-hidden="true"
      data-assistant-liquid=""
      data-activity={activity}
      data-motion={enhanced ? "active" : "paused"}
      data-renderer={enhanced ? "liquid-gooey" : "static"}
    >
      {enhanced ? (
        <Liquid
          className={styles.liquid}
          blur={3}
          contrast={20}
          fill="var(--assistant-liquid-fill)"
          filterPadding={4}
          waviness={0}
        >
          {positions.map((position, index) => (
            <Liquid.Item
              key={index}
              className={styles.item}
              x={position.x}
              y={position.y}
              radius={4}
              transition={{
                duration: 280,
                ease: "cubic-bezier(0.22, 1, 0.36, 1)",
              }}
            >
              <span className={styles.drop} />
            </Liquid.Item>
          ))}
        </Liquid>
      ) : (
        <span className={styles.fallback}>
          <span className={styles.fallbackDrop} />
          <span className={styles.fallbackDrop} />
        </span>
      )}
    </div>
  );
}

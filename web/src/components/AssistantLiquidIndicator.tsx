"use client";

import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import styles from "./AssistantLiquidIndicator.module.css";

export type AssistantLiquidActivity = "shopping" | "store" | "seller";

type LiquidComponent = typeof import("liquid-gooey")["Liquid"];
type Point = { x: number; y: number };

type LiquidErrorBoundaryProps = {
  children: ReactNode;
  fallback: ReactNode;
  onFailure: () => void;
};

type LiquidErrorBoundaryState = { failed: boolean };

class LiquidErrorBoundary extends Component<
  LiquidErrorBoundaryProps,
  LiquidErrorBoundaryState
> {
  state: LiquidErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): LiquidErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onFailure();
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function StaticLiquidMarker() {
  return (
    <span className={styles.fallback}>
      <span className={styles.fallbackDrop} />
      <span className={styles.fallbackDrop} />
    </span>
  );
}

function hasLiquidRuntimeCapabilities() {
  return (
    typeof MutationObserver === "function" &&
    typeof ResizeObserver === "function" &&
    typeof window.requestAnimationFrame === "function" &&
    typeof window.cancelAnimationFrame === "function"
  );
}

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
    try {
      if (typeof window.matchMedia !== "function") return;

      const media = window.matchMedia("(prefers-reduced-motion: reduce)");
      if (
        typeof media?.addEventListener !== "function" ||
        typeof media.removeEventListener !== "function"
      ) {
        return;
      }

      const reduced = media.matches;
      const sync = () => setReducedMotion(media.matches);
      media.addEventListener("change", sync);
      setReducedMotion(reduced);
      return () => {
        try {
          media.removeEventListener("change", sync);
        } catch {
          // A partial runtime must not break the static fallback during cleanup.
        }
      };
    } catch {
      setReducedMotion(true);
    }
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
  const [enhancementFailed, setEnhancementFailed] = useState(false);
  const enhancementAllowed = useMotionGate(rootRef);
  const disableEnhancement = useCallback(() => {
    setEnhancementFailed(true);
  }, []);

  useEffect(() => {
    if (
      !enhancementAllowed ||
      enhancementFailed ||
      Liquid !== null ||
      !hasLiquidRuntimeCapabilities()
    ) {
      return;
    }

    let cancelled = false;
    void import("liquid-gooey")
      .then((module) => {
        if (!cancelled) setLiquid(() => module.Liquid);
      })
      .catch(() => {
        if (!cancelled) disableEnhancement();
      });
    return () => {
      cancelled = true;
    };
  }, [Liquid, disableEnhancement, enhancementAllowed, enhancementFailed]);

  const enhanced = Liquid !== null && enhancementAllowed && !enhancementFailed;

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
        <LiquidErrorBoundary
          fallback={<StaticLiquidMarker />}
          onFailure={disableEnhancement}
        >
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
        </LiquidErrorBoundary>
      ) : (
        <StaticLiquidMarker />
      )}
    </div>
  );
}

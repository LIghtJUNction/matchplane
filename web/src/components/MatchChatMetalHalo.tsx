"use client";

import {
  Component,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { MetalFx as MetalFxExport } from "metal-fx";

import styles from "./MatchChatMetalHalo.module.css";

const PULSE_DURATION_MS = 1_400;
const NO_REFLECTION_TARGETS: ReadonlyArray<RefObject<HTMLElement | null>> = [];

type Theme = "dark" | "light";
type MetalFxComponent = typeof MetalFxExport;
type LegacyMediaQueryList = {
  addListener?: (listener: () => void) => void;
  removeListener?: (listener: () => void) => void;
};

type MetalFxBoundaryProps = {
  children: ReactNode;
  onError: () => void;
};

class MetalFxBoundary extends Component<
  MetalFxBoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function documentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function supportsMetalFx(): boolean {
  if (
    typeof ResizeObserver === "undefined" ||
    typeof CanvasRenderingContext2D === "undefined" ||
    typeof WebGLRenderingContext === "undefined" ||
    typeof window.requestAnimationFrame !== "function" ||
    typeof window.cancelAnimationFrame !== "function"
  ) {
    return false;
  }

  try {
    const copyCanvas = document.createElement("canvas");
    const copyContext = copyCanvas.getContext("2d");
    if (!copyContext || typeof copyContext.roundRect !== "function") {
      return false;
    }

    const glCanvas = document.createElement("canvas");
    const gl = glCanvas.getContext("webgl");
    if (!gl) return false;

    if (typeof gl.getExtension === "function") {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    return true;
  } catch {
    return false;
  }
}

export function MatchChatMetalHalo({ active }: { active: boolean }) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const previousActiveRef = useRef(false);
  const [hydrated, setHydrated] = useState(false);
  const [pageVisible, setPageVisible] = useState(false);
  const [inView, setInView] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(true);
  const [theme, setTheme] = useState<Theme>("light");
  const [pulseActive, setPulseActive] = useState(false);
  const [pulseSequence, setPulseSequence] = useState(0);
  const [capabilitiesReady, setCapabilitiesReady] = useState(false);
  const [runtimeFailed, setRuntimeFailed] = useState(false);
  const [MetalFx, setMetalFx] = useState<MetalFxComponent | null>(null);

  useEffect(() => {
    setHydrated(true);
    setPageVisible(document.visibilityState !== "hidden");
    setTheme(documentTheme());

    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const syncMotion = () => setReducedMotion(media?.matches ?? true);
    const syncVisibility = () =>
      setPageVisible(document.visibilityState !== "hidden");
    const syncTheme = () => setTheme(documentTheme());

    const legacyMedia = media as unknown as LegacyMediaQueryList | undefined;
    syncMotion();
    if (typeof media?.addEventListener === "function") {
      media.addEventListener("change", syncMotion);
    } else if (typeof legacyMedia?.addListener === "function") {
      legacyMedia.addListener(syncMotion);
    }
    document.addEventListener("visibilitychange", syncVisibility);

    const themeObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(syncTheme);
    themeObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    const root = rootRef.current;
    const intersectionObserver =
      root && typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver(([entry]) => {
            setInView(entry?.isIntersecting ?? false);
          })
        : null;
    intersectionObserver?.observe(root as Element);

    return () => {
      if (typeof media?.removeEventListener === "function") {
        media.removeEventListener("change", syncMotion);
      } else if (typeof legacyMedia?.removeListener === "function") {
        legacyMedia.removeListener(syncMotion);
      }
      document.removeEventListener("visibilitychange", syncVisibility);
      themeObserver?.disconnect();
      intersectionObserver?.disconnect();
    };
  }, []);

  useEffect(() => {
    const wasActive = previousActiveRef.current;
    previousActiveRef.current = active;

    if (!active) {
      setPulseActive(false);
      return;
    }
    if (wasActive) return;

    setPulseSequence((current) => current + 1);
    setPulseActive(true);
  }, [active]);

  const gateOpen =
    hydrated &&
    active &&
    pulseActive &&
    pageVisible &&
    inView &&
    !reducedMotion;

  useEffect(() => {
    setCapabilitiesReady(false);
    setRuntimeFailed(false);
    setMetalFx(null);
    if (!gateOpen || !supportsMetalFx()) return;

    let cancelled = false;
    setCapabilitiesReady(true);
    void import("metal-fx")
      .then((module) => {
        if (!cancelled) setMetalFx(() => module.MetalFx);
      })
      .catch(() => {
        if (!cancelled) setRuntimeFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [gateOpen, pulseSequence]);

  const disableRuntime = useCallback(() => setRuntimeFailed(true), []);
  const motionActive = gateOpen && capabilitiesReady && !runtimeFailed;
  const rendererActive = motionActive && MetalFx !== null;

  useEffect(() => {
    if (!rendererActive) return;
    const timer = window.setTimeout(
      () => setPulseActive(false),
      PULSE_DURATION_MS,
    );
    return () => window.clearTimeout(timer);
  }, [pulseSequence, rendererActive]);

  return (
    <span
      ref={rootRef}
      className={styles.root}
      aria-hidden="true"
      inert
      data-match-chat-metal=""
      data-active={active ? "true" : "false"}
      data-renderer={rendererActive ? "metal-fx" : "static"}
      data-motion={motionActive ? "active" : "paused"}
      data-theme={theme}
    >
      <span className={styles.fallback} />
      {rendererActive ? (
        <MetalFxBoundary key={pulseSequence} onError={disableRuntime}>
          <MetalFx
            className={styles.metal}
            variant="circle"
            preset="silver"
            theme={theme}
            strength={0.38}
            disableGlow
            normalizeHostStyles={false}
            reflectionTargets={NO_REFLECTION_TARGETS}
            shaderScale={0.9}
            ringCssPx={0.8}
            scale={0.72}
          >
            <span className={styles.host} />
          </MetalFx>
        </MetalFxBoundary>
      ) : null}
    </span>
  );
}

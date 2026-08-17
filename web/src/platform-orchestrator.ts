import type { PlatformRouteCandidate, PlatformRouteDecision } from "./platform-router";

export interface PlatformRouteTrace {
  platformPath: string;
  decision: PlatformRouteDecision;
}

export interface RecursivePlatformRouting {
  routePlan: PlatformRouteCandidate[];
  trace: PlatformRouteTrace[];
  truncated: boolean;
}

interface PendingNode {
  platformPath: string;
  candidates: PlatformRouteCandidate[];
  depth: number;
}

const PROTOCOL_MAX_STEPS = 16;
const DEFAULT_MAX_STEPS = 8;
const PROTOCOL_MAX_HOPS = 32;
const DEFAULT_MAX_FANOUT = 4;

/**
 * Expand only authorized direct-child candidates. The orchestrator never
 * enumerates a whole tree for the model: every selected child must be loaded
 * and routed again at its own path, with bounded work and a cycle guard.
 */
export async function expandPlatformRouteTree(input: {
  platformPath: string;
  narrative: string;
  candidates: PlatformRouteCandidate[];
  loadChildren: (platformPath: string) => Promise<PlatformRouteCandidate[]>;
  decide: (input: {
    platformPath: string;
    narrative: string;
    candidates: PlatformRouteCandidate[];
  }) => Promise<PlatformRouteDecision>;
  maxSteps?: number;
  maxDepth?: number;
  maxFanout?: number;
}): Promise<RecursivePlatformRouting> {
  const maxSteps = boundedPositiveInteger(input.maxSteps, DEFAULT_MAX_STEPS, PROTOCOL_MAX_STEPS);
  const maxDepth = boundedPositiveInteger(input.maxDepth, maxSteps, PROTOCOL_MAX_STEPS);
  const maxFanout = boundedPositiveInteger(input.maxFanout, DEFAULT_MAX_FANOUT, DEFAULT_MAX_FANOUT * 4);
  const trace: PlatformRouteTrace[] = [];
  const routePlan: PlatformRouteCandidate[] = [];
  const queue: PendingNode[] = [{
    platformPath: input.platformPath,
    candidates: input.candidates,
    depth: 0,
  }];
  const visited = new Set([input.platformPath]);
  let truncated = false;

  while (queue.length > 0 && trace.length < maxSteps) {
    const node = queue.shift();
    if (!node) break;

    const decision = await input.decide({
      platformPath: node.platformPath,
      narrative: input.narrative,
      candidates: node.candidates,
    });
    trace.push({ platformPath: node.platformPath, decision });

    const candidatesBySlug = new Map(node.candidates.map((candidate) => [candidate.slug, candidate]));
    const availableHops = Math.max(0, PROTOCOL_MAX_HOPS - routePlan.length);
    const selectedSlugs = decision.selectedSlugs.slice(0, Math.min(maxFanout, availableHops));
    if (selectedSlugs.length < decision.selectedSlugs.length) truncated = true;
    const selected = selectedSlugs.flatMap((slug) => {
      const candidate = candidatesBySlug.get(slug);
      return candidate ? [{ candidate, childDepth: node.depth + 1 }] : [];
    });
    if (selected.length < selectedSlugs.length) truncated = true;

    // Child registry reads are independent. Parallel loading shortens tail latency while the
    // model decisions themselves remain sequential and bounded by maxSteps.
    const loaded = await Promise.all(selected.map(async ({ candidate, childDepth }) => {
      if (routePlan.length >= PROTOCOL_MAX_HOPS) return { candidate, childDepth, children: [], failed: false };
      routePlan.push({ ...candidate, depth: childDepth });
      try {
        return {
          candidate,
          childDepth,
          children: await input.loadChildren(candidate.path),
          failed: false,
        };
      } catch {
        return { candidate, childDepth, children: [], failed: true };
      }
    }));

    for (const { candidate, childDepth, children, failed } of loaded) {
      if (failed) {
        truncated = true;
        continue;
      }
      // Probe the active registry at the boundary so hitting maxDepth is an
      // explicit degraded result rather than silently dropping descendants.
      if (children.length === 0) continue;
      if (childDepth >= maxDepth || visited.has(candidate.path)) {
        truncated = true;
        continue;
      }
      visited.add(candidate.path);
      queue.push({ platformPath: candidate.path, candidates: children, depth: childDepth });
    }
  }

  if (queue.length > 0) truncated = true;
  return { routePlan, trace, truncated };
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && value !== undefined
    ? Math.max(1, Math.min(maximum, value))
    : fallback;
}

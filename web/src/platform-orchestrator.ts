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
const PROTOCOL_MAX_HOPS = 100;

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
}): Promise<RecursivePlatformRouting> {
  const maxSteps = boundedPositiveInteger(input.maxSteps, DEFAULT_MAX_STEPS, PROTOCOL_MAX_STEPS);
  const maxDepth = boundedPositiveInteger(input.maxDepth, maxSteps, PROTOCOL_MAX_STEPS);
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
    for (const slug of decision.selectedSlugs) {
      const selected = candidatesBySlug.get(slug);
      if (!selected) continue;
      if (routePlan.length >= PROTOCOL_MAX_HOPS) {
        truncated = true;
        break;
      }

      const childDepth = node.depth + 1;
      routePlan.push({ ...selected, depth: childDepth });

      // Probe the active registry at the boundary so hitting maxDepth is an
      // explicit degraded result rather than silently dropping descendants.
      const children = await input.loadChildren(selected.path);
      if (children.length === 0) continue;
      if (childDepth >= maxDepth || visited.has(selected.path)) {
        truncated = true;
        continue;
      }
      visited.add(selected.path);
      queue.push({ platformPath: selected.path, candidates: children, depth: childDepth });
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

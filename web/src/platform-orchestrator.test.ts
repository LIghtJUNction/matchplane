import { describe, expect, it, vi } from "vitest";

import { expandPlatformRouteTree } from "./platform-orchestrator";
import type { PlatformRouteCandidate, PlatformRouteDecision } from "./platform-router";

function candidate(slug: string, path: string, depth = 1): PlatformRouteCandidate {
  return {
    slug,
    path,
    displayName: slug,
    description: slug,
    capabilities: ["demand", "supply"],
    agentStages: ["merchant", "inventory"],
    agentSkills: ["matchplane.matching.v1"],
    depth,
  };
}

function decision(selectedSlugs: string[]): PlatformRouteDecision {
  return {
    selectedSlugs,
    source: "ai",
    model: "test-router",
    rationale: "test",
    confidence: 1,
    degraded: false,
    costBearer: "platform",
    budget: { maxInputCharacters: 24_000, maxOutputTokens: 512 },
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
}

describe("bounded recursive platform orchestrator", () => {
  it("routes only selected direct children at each level", async () => {
    const loadChildren = vi.fn(async (path: string) => {
      if (path === "/market") return [candidate("auto", "/market/auto")];
      if (path === "/market/auto") return [candidate("dealer", "/market/auto/dealer")];
      return [];
    });
    const decide = vi.fn(async ({ platformPath }: { platformPath: string }) => {
      if (platformPath === "/") return decision(["market"]);
      if (platformPath === "/market") return decision(["auto"]);
      return decision(["dealer"]);
    });

    const result = await expandPlatformRouteTree({
      platformPath: "/",
      narrative: "找一个合适的服务",
      candidates: [candidate("market", "/market"), candidate("sibling", "/sibling")],
      loadChildren,
      decide,
    });

    expect(result.routePlan.map((item) => item.path)).toEqual([
      "/market",
      "/market/auto",
      "/market/auto/dealer",
    ]);
    expect(result.trace.map((item) => item.platformPath)).toEqual(["/", "/market", "/market/auto"]);
    expect(decide).toHaveBeenCalledTimes(3);
    expect(loadChildren).toHaveBeenCalledWith("/market");
    expect(loadChildren).not.toHaveBeenCalledWith("/sibling");
    expect(result.truncated).toBe(false);
  });

  it("stops at the configured step bound and marks truncation", async () => {
    const loadChildren = vi.fn(async (path: string) => [candidate(`${path.slice(1) || "root"}-child`, `${path}/child`)]);
    const decide = vi.fn(async ({ candidates }: { candidates: PlatformRouteCandidate[] }) => decision([candidates[0]?.slug ?? ""]));

    const result = await expandPlatformRouteTree({
      platformPath: "/",
      narrative: "继续向下找",
      candidates: [candidate("one", "/one")],
      loadChildren,
      decide,
      maxSteps: 2,
      maxDepth: 16,
    });

    expect(result.trace).toHaveLength(2);
    expect(result.routePlan).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});

import { isUuid } from "./lib/uuid";
export const AGENT_HANDOFF_PROTOCOL = "matchplane.agent/v1" as const;

/** Domain-owned stage taxonomy. `platform`/`merchant`/`inventory` remain valid examples, not a root enum. */
export type AgentHandoffStage = string;

export interface AgentHandoffEnvelope {
  requestId: string;
  stage: AgentHandoffStage;
  platformPath: string;
  narrative: string;
  requirements: Record<string, unknown>;
  agent: {
    id: string;
    version: string;
    capabilities: string[];
  };
  budget: {
    maxSteps: number;
    maxInputCharacters: number;
    maxOutputTokens: number;
    costBearer: "caller";
  };
  selectedRefs: string[];
}

type ParseResult =
  | { ok: true; value: AgentHandoffEnvelope }
  | { ok: false; error: string };

const MAX_REQUIREMENTS_BYTES = 32 * 1024;
const MAX_SELECTED_REFS = 100;
const allowedKeys = new Set([
  "protocol",
  "request_id",
  "stage",
  "scope",
  "intent",
  "agent",
  "budget",
  "selected_refs",
]);

/** Parse the strict external-Agent handoff contract before touching the database. */
export function parseAgentHandoff(value: unknown): ParseResult {
  if (!isRecord(value))
    return { ok: false, error: "handoff must be a JSON object" };
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknownKey)
    return {
      ok: false,
      error: `handoff contains an unsupported field: ${unknownKey}`,
    };
  if (value.protocol !== AGENT_HANDOFF_PROTOCOL)
    return { ok: false, error: "protocol must be matchplane.agent/v1" };
  if (!isUuid(value.request_id))
    return { ok: false, error: "request_id must be a UUID" };

  const stage = value.stage;
  if (!stringMatches(stage, /^[a-z0-9][a-z0-9._:-]{1,127}$/)) {
    return {
      ok: false,
      error: "stage must be a bounded lowercase taxonomy key",
    };
  }

  const scope = value.scope;
  if (
    !isRecord(scope) ||
    Object.keys(scope).some((key) => key !== "platform_path")
  ) {
    return { ok: false, error: "scope.platform_path is required" };
  }
  const platformPath = normalizePlatformPath(scope.platform_path);
  if (!platformPath)
    return { ok: false, error: "scope.platform_path is invalid" };

  const intent = value.intent;
  if (
    !isRecord(intent) ||
    Object.keys(intent).some(
      (key) => key !== "narrative" && key !== "requirements",
    )
  ) {
    return {
      ok: false,
      error: "intent.narrative and intent.requirements are required",
    };
  }
  if (
    typeof intent.narrative !== "string" ||
    intent.narrative.trim().length === 0 ||
    intent.narrative.length > 10_000
  ) {
    return {
      ok: false,
      error: "intent.narrative must contain 1..10000 characters",
    };
  }
  if (!isRecord(intent.requirements))
    return { ok: false, error: "intent.requirements must be an object" };
  const requirementsBytes = Buffer.byteLength(
    JSON.stringify(intent.requirements),
    "utf8",
  );
  if (requirementsBytes > MAX_REQUIREMENTS_BYTES)
    return { ok: false, error: "intent.requirements is too large" };

  const agent = value.agent;
  if (
    !isRecord(agent) ||
    Object.keys(agent).some(
      (key) => !["id", "version", "capabilities"].includes(key),
    )
  ) {
    return {
      ok: false,
      error: "agent.id, agent.version and agent.capabilities are required",
    };
  }
  if (!stringMatches(agent.id, /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/))
    return { ok: false, error: "agent.id is invalid" };
  if (!stringMatches(agent.version, /^[a-zA-Z0-9][a-zA-Z0-9._:+-]{0,127}$/))
    return { ok: false, error: "agent.version is invalid" };
  const capabilities = boundedStringArray(
    agent.capabilities,
    64,
    /^[a-z0-9][a-z0-9._:-]{1,127}$/,
  );
  if (!capabilities)
    return { ok: false, error: "agent.capabilities is invalid" };

  const budget = value.budget;
  if (
    !isRecord(budget) ||
    Object.keys(budget).some(
      (key) =>
        ![
          "max_steps",
          "max_input_characters",
          "max_output_tokens",
          "cost_bearer",
        ].includes(key),
    )
  ) {
    return { ok: false, error: "budget is invalid" };
  }
  const maxSteps = boundedInteger(budget.max_steps, 1, 16);
  const maxInputCharacters = boundedInteger(
    budget.max_input_characters,
    1,
    24_000,
  );
  const maxOutputTokens = boundedInteger(budget.max_output_tokens, 64, 2_048);
  if (
    maxSteps === null ||
    maxInputCharacters === null ||
    maxOutputTokens === null ||
    budget.cost_bearer !== "caller"
  ) {
    return {
      ok: false,
      error: "external handoff must use bounded caller-funded budget",
    };
  }

  const selectedRefs =
    value.selected_refs === undefined
      ? []
      : boundedStringArray(
          value.selected_refs,
          MAX_SELECTED_REFS,
          /^.{1,256}$/u,
        );
  if (!selectedRefs) return { ok: false, error: "selected_refs is invalid" };

  return {
    ok: true,
    value: {
      requestId: value.request_id,
      stage,
      platformPath,
      narrative: intent.narrative.trim(),
      requirements: intent.requirements,
      agent: { id: agent.id, version: agent.version, capabilities },
      budget: {
        maxSteps,
        maxInputCharacters,
        maxOutputTokens,
        costBearer: "caller",
      },
      selectedRefs,
    },
  };
}

export function normalizePlatformPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 512) return null;
  const normalized = `/${value.split("/").filter(Boolean).join("/")}`;
  return normalized === "/" ||
    /^\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(normalized)
    ? normalized
    : null;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  return Number.isSafeInteger(value) &&
    typeof value === "number" &&
    value >= minimum &&
    value <= maximum
    ? value
    : null;
}

function boundedStringArray(
  value: unknown,
  maximum: number,
  pattern: RegExp,
): string[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const values = value.filter(
    (item): item is string => typeof item === "string",
  );
  if (
    values.length !== value.length ||
    values.some((item) => !pattern.test(item))
  )
    return null;
  return [...new Set(values)];
}

function stringMatches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Small, dependency-free validation for the HTTP MCP boundary.
 *
 * MCP clients are allowed to call a tool without implementing the advertised JSON Schema. The
 * downstream gateway still owns authorization and domain validation, but rejecting malformed
 * scope/identity values here keeps the HTTP facade deterministic and prevents invalid values from
 * being copied into paths or capability headers.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLATFORM_PATH_PATTERN = /^\/(?:[a-z0-9-]+(?:\/[a-z0-9-]+)*)?$/;
const MAX_OBJECT_BYTES = 128 * 1024;

export function validateMcpToolArguments(
  name: string,
  args: Record<string, unknown>,
): string | null {
  switch (name) {
    case "platform.match":
      return validatePlatformMatch(args);
    case "platform.agent.handoff":
      return validateAgentHandoff(args);
    case "platform.child.tool":
      return validateChildTool(args);
    case "marketplace.agent.session":
      return validateAgentSession(args);
    case "marketplace.intent.create":
      return validateIntent(args);
    case "marketplace.offer.create":
      return validateOffer(args);
    case "marketplace.offer.match":
      return validateOfferMatch(args);
    case "marketplace.introduction.create":
      return validateIntroduction(args);
    case "marketplace.introductions.list":
      return validateIntroductionList(args);
    case "marketplace.introduction.contact.request":
    case "marketplace.introduction.contact.consent":
    case "marketplace.introduction.contact.release":
      return validateContactAction(args);
    default:
      return "unsupported MatchPlane tool";
  }
}

function validateChildTool(args: Record<string, unknown>): string | null {
  const platformPath = platformPathArgument(args, "platform_path");
  if (platformPath) return platformPath;
  const toolName = args.tool_name;
  if (typeof toolName !== "string" || !/^[a-z0-9][a-z0-9._:-]{1,127}$/.test(toolName)) {
    return "tool_name must be a valid MCP tool name";
  }
  const toolArguments = recordArgument(args, "arguments");
  if (typeof toolArguments === "string") return toolArguments;
  return optionalString(args, "request_id", 200);
}

function validatePlatformMatch(args: Record<string, unknown>): string | null {
  const narrative = requiredString(args, "narrative", 10_000);
  if (narrative) return narrative;
  const platformPath = optionalPlatformPath(args);
  if (platformPath) return platformPath;
  return optionalString(args, "idempotency_key", 240);
}

function validateAgentHandoff(args: Record<string, unknown>): string | null {
  if (args.protocol !== "matchplane.agent/v1") return "protocol must be matchplane.agent/v1";
  const requestId = uuidArgument(args, "request_id");
  if (requestId) return requestId;
  if (typeof args.stage !== "string" || !/^[a-z0-9][a-z0-9._:-]{1,127}$/.test(args.stage)) {
    return "stage must be a bounded lowercase taxonomy key";
  }
  const scope = recordArgument(args, "scope");
  if (typeof scope === "string") return scope;
  const platformPath = platformPathArgument(scope!, "platform_path");
  if (platformPath) return platformPath;
  const intent = recordArgument(args, "intent");
  if (typeof intent === "string") return intent;
  const narrative = requiredString(intent!, "narrative", 10_000);
  if (narrative) return narrative;
  const requirements = recordArgument(intent!, "requirements");
  if (typeof requirements === "string") return requirements;
  const agent = recordArgument(args, "agent");
  if (typeof agent === "string") return agent;
  for (const key of ["id", "version"] as const) {
    const error = requiredString(agent!, key, 128);
    if (error) return error;
  }
  const capabilities = stringArrayArgument(agent!, "capabilities", 64, 256);
  if (capabilities) return capabilities;
  const budget = recordArgument(args, "budget");
  if (typeof budget === "string") return budget;
  for (const [key, minimum, maximum] of [
    ["max_steps", 1, 16],
    ["max_input_characters", 1, 24_000],
    ["max_output_tokens", 64, 2_048],
  ] as const) {
    const error = integerArgument(budget!, key, minimum, maximum);
    if (error) return error;
  }
  if (budget!.cost_bearer !== "caller") return "budget.cost_bearer must be caller";
  if (args.selected_refs !== undefined) {
    const error = stringArrayArgument(args, "selected_refs", 100, 256);
    if (error) return error;
  }
  return null;
}

function validateAgentSession(args: Record<string, unknown>): string | null {
  const scope = requiredScope(args);
  if (scope) return scope;
  if (args.side !== "demand" && args.side !== "supply") return "side must be demand or supply";
  if (args.role !== undefined && args.role !== "buyer" && args.role !== "seller") {
    return "role must be buyer or seller";
  }
  return optionalString(args, "display_name", 200);
}

function validateIntent(args: Record<string, unknown>): string | null {
  const scope = requiredScope(args);
  if (scope) return scope;
  if (args.side !== "demand" && args.side !== "supply") return "side must be demand or supply";
  const participant = uuidArgument(args, "participant_id");
  if (participant) return participant;
  const narrative = requiredString(args, "narrative", 10_000);
  if (narrative) return narrative;
  const idempotency = requiredString(args, "idempotency_key", 240);
  if (idempotency) return idempotency;
  const objects = validateOptionalObjects(args, ["attributes", "terms"]);
  if (objects) return objects;
  return optionalUuid(args, "intent_id");
}

function validateOffer(args: Record<string, unknown>): string | null {
  const scope = requiredScope(args);
  if (scope) return scope;
  const party = uuidArgument(args, "supply_party_id");
  if (party) return party;
  const externalKey = requiredString(args, "external_key", 256);
  if (externalKey) return externalKey;
  const displayName = requiredString(args, "display_name", 500);
  if (displayName) return displayName;
  const objects = validateOptionalObjects(args, ["attributes", "terms"]);
  if (objects) return objects;
  const offerId = optionalUuid(args, "offer_id");
  if (offerId) return offerId;
  return optionalUuid(args, "asset_id", true);
}

function validateOfferMatch(args: Record<string, unknown>): string | null {
  const scope = requiredScope(args);
  if (scope) return scope;
  const intent = uuidArgument(args, "intent_id");
  if (intent) return intent;
  const participant = uuidArgument(args, "participant_id");
  if (participant) return participant;
  return optionalInteger(args, "limit", 1, 100);
}

function validateIntroduction(args: Record<string, unknown>): string | null {
  const scope = requiredScope(args);
  if (scope) return scope;
  for (const key of ["intent_id", "offer_id", "participant_id"] as const) {
    const error = uuidArgument(args, key);
    if (error) return error;
  }
  if (typeof args.score !== "number" || !Number.isFinite(args.score) || args.score < 0 || args.score > 1) {
    return "score must be a finite number between 0 and 1";
  }
  const idempotency = requiredString(args, "idempotency_key", 240);
  if (idempotency) return idempotency;
  const expiresAt = requiredString(args, "expires_at", 64);
  if (expiresAt) return expiresAt;
  if (!Number.isFinite(Date.parse(args.expires_at as string))) return "expires_at must be a valid date-time";
  if (args.reasons !== undefined) return stringArrayArgument(args, "reasons", 24, 500);
  return optionalUuid(args, "introduction_id");
}

function validateIntroductionList(args: Record<string, unknown>): string | null {
  const scope = requiredScope(args);
  if (scope) return scope;
  return uuidArgument(args, "participant_id");
}

function validateContactAction(args: Record<string, unknown>): string | null {
  const scope = requiredScope(args);
  if (scope) return scope;
  const introduction = uuidArgument(args, "introduction_id");
  if (introduction) return introduction;
  const participant = uuidArgument(args, "participant_id");
  if (participant) return participant;
  return requiredString(args, "idempotency_key", 240);
}

function requiredScope(args: Record<string, unknown>): string | null {
  const tenant = uuidArgument(args, "tenant_id");
  if (tenant) return tenant;
  const domain = uuidArgument(args, "domain_id");
  if (domain) return domain;
  return platformPathArgument(args, "platform_path");
}

function optionalPlatformPath(args: Record<string, unknown>): string | null {
  if (args.platformPath === undefined) return null;
  return platformPathArgument(args, "platformPath");
}

function platformPathArgument(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (typeof value !== "string" || value.length > 512 || !PLATFORM_PATH_PATTERN.test(value)) {
    return `${key} must be a normalized platform path`;
  }
  return null;
}

function uuidArgument(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && UUID_PATTERN.test(value)
    ? null
    : `${key} must be a UUID`;
}

function optionalUuid(args: Record<string, unknown>, key: string, nullable = false): string | null {
  if (args[key] === undefined || (nullable && args[key] === null)) return null;
  return uuidArgument(args, key);
}

function requiredString(args: Record<string, unknown>, key: string, maximum: number): string | null {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum
    ? null
    : `${key} must contain 1..${maximum} characters`;
}

function optionalString(args: Record<string, unknown>, key: string, maximum: number): string | null {
  if (args[key] === undefined) return null;
  return requiredString(args, key, maximum);
}

function recordArgument(args: Record<string, unknown>, key: string): Record<string, unknown> | string {
  const value = args[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${key} must be an object`;
  try {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_OBJECT_BYTES) return `${key} is too large`;
  } catch {
    return `${key} must be JSON serializable`;
  }
  return value as Record<string, unknown>;
}

function validateOptionalObjects(args: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    if (args[key] === undefined) continue;
    const value = recordArgument(args, key);
    if (typeof value === "string") return value;
  }
  return null;
}

function stringArrayArgument(
  args: Record<string, unknown>,
  key: string,
  maximumItems: number,
  maximumLength: number,
): string | null {
  const value = args[key];
  if (!Array.isArray(value) || value.length > maximumItems || value.some((item) => typeof item !== "string" || item.length > maximumLength)) {
    return `${key} must be an array of at most ${maximumItems} strings`;
  }
  return null;
}

function integerArgument(args: Record<string, unknown>, key: string, minimum: number, maximum: number): string | null {
  const value = args[key];
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
    ? null
    : `${key} must be an integer between ${minimum} and ${maximum}`;
}

function optionalInteger(args: Record<string, unknown>, key: string, minimum: number, maximum: number): string | null {
  if (args[key] === undefined) return null;
  return integerArgument(args, key, minimum, maximum);
}

import {
  hasOnlyPublicAddresses,
  type ResolveAddresses,
} from "../public-endpoint";
import {
  normalizeEndpoint,
  normalizeProtocol,
  normalizeReasoningEfforts,
  type ManagedRouterModel,
  type ManagedRouterProtocol,
} from "./contract";
import {
  readManagedPlatformRouterConfig,
  readManagedPlatformRouterDraftConfig,
} from "./lifecycle";

export async function listManagedPlatformRouterModels(input: {
  endpoint: string;
  protocol: ManagedRouterProtocol;
  apiKey?: string;
  fetcher?: typeof fetch;
  resolveAddresses?: ResolveAddresses;
}): Promise<ManagedRouterModel[]> {
  const endpoint = normalizeEndpoint(input.endpoint);
  const protocol = normalizeProtocol(input.protocol);
  const apiKey = resolveModelDiscoveryApiKey(input.apiKey);
  if (!apiKey) throw new Error("请先填写 API Key");
  const request = modelListRequest(endpoint, protocol, apiKey);
  if (!(await hasOnlyPublicAddresses(request.url, input.resolveAddresses))) {
    throw new Error("模型网关必须解析到公网地址");
  }
  const response = await (input.fetcher ?? fetch)(request.url, {
    headers: request.headers,
    signal: AbortSignal.timeout(8_000),
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`模型列表请求失败（${response.status}）`);
  const payload: unknown = await response.json();
  const models = parseModelList(payload, protocol);
  if (!models.length) throw new Error("模型服务没有返回可选择的模型");
  return models;
}

export function modelReasoningEffortsFromRecord(
  record: Record<string, unknown>,
): string[] {
  const capabilities = isRecord(record.capabilities) ? record.capabilities : {};
  const reasoning = isRecord(capabilities.reasoning)
    ? capabilities.reasoning
    : {};
  return normalizeReasoningEfforts(
    record.supported_reasoning_efforts ??
      record.reasoning_efforts ??
      capabilities.reasoning_efforts ??
      reasoning.efforts ??
      reasoning.levels,
  );
}

function resolveModelDiscoveryApiKey(inputApiKey: string | undefined): string | null {
  const supplied = inputApiKey?.trim();
  if (supplied) return supplied;
  const draft = readManagedPlatformRouterDraftConfig();
  if (draft?.apiKey) return draft.apiKey;
  return readManagedPlatformRouterConfig()?.apiKey ?? null;
}

function modelListRequest(
  endpoint: string,
  protocol: ManagedRouterProtocol,
  apiKey: string,
): { url: string; headers: Record<string, string> } {
  if (protocol === "gemini-generate-content") {
    return {
      url: appendProviderPath(endpoint, "v1beta", "models"),
      headers: { "x-goog-api-key": apiKey },
    };
  }
  if (protocol === "anthropic-messages") {
    return {
      url: appendProviderPath(endpoint, "v1", "models"),
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    };
  }
  return {
    url: appendProviderPath(endpoint, "v1", "models"),
    headers: { authorization: `Bearer ${apiKey}` },
  };
}

function appendProviderPath(
  endpoint: string,
  version: "v1" | "v1beta",
  resource: string,
): string {
  return endpoint.endsWith(`/${version}`)
    ? `${endpoint}/${resource}`
    : `${endpoint}/${version}/${resource}`;
}

function parseModelList(
  value: unknown,
  protocol: ManagedRouterProtocol,
): ManagedRouterModel[] {
  if (!isRecord(value)) return [];
  const records = value.data ?? value.models;
  if (!Array.isArray(records)) return [];
  const names = records.flatMap((record) => {
    if (!isRecord(record)) return [];
    const candidate = record.id ?? record.name;
    if (typeof candidate !== "string") return [];
    const normalized =
      protocol === "gemini-generate-content"
        ? candidate.replace(/^models\//, "")
        : candidate;
    return /^[A-Za-z0-9._:/-]{1,256}$/.test(normalized)
      ? [
          {
            id: normalized,
            reasoningEfforts: modelReasoningEffortsFromRecord(record),
          },
        ]
      : [];
  });
  return [...new Map(names.map((model) => [model.id, model])).values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .slice(0, 512);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

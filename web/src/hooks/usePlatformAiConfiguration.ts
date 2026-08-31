"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import {
  activateManagedPlatformRouterConfig,
  getManagedPlatformRouterState,
  saveManagedPlatformRouterConfig,
  testPlatformAi,
  type ManagedPlatformRouterConfig,
  type ManagedPlatformRouterDraftConfig,
  type PlatformRouterEffectiveStatus,
} from "../api";

export type PlatformAiProviderChoice =
  | "openai"
  | "anthropic"
  | "gemini"
  | "custom";

type PlatformAiFeedback = {
  tone: "error" | "success" | "working";
  text: string;
};

interface PlatformAiFormState {
  provider: PlatformAiProviderChoice;
  endpoint: string;
  model: string;
  protocol: ManagedPlatformRouterConfig["protocol"];
  apiKey: string;
  showApiKey: boolean;
  assistantInstructions: string;
  assistantMaxOutputTokens: string;
  assistantTemperature: string;
  assistantMaxSteps: string;
  assistantTimeoutMs: string;
  assistantReasoningEffort: ManagedPlatformRouterConfig["assistantReasoningEffort"];
}

interface PlatformAiManagedState {
  config: ManagedPlatformRouterConfig | null;
  draft: ManagedPlatformRouterDraftConfig | null;
  effective: PlatformRouterEffectiveStatus | null;
}

interface PlatformAiAsyncState {
  loading: boolean;
  loadError: string | null;
  action: "idle" | "save-test" | "activate";
  feedback: PlatformAiFeedback | null;
  reloadVersion: number;
}

export interface PlatformAiConfigurationController {
  canEdit: boolean;
  form: PlatformAiFormState;
  managed: PlatformAiManagedState;
  async: PlatformAiAsyncState;
  reasoningEfforts: string[];
  interactionLocked: boolean;
  savedCredentialFitsConnection: boolean;
  hasUnsavedChanges: boolean;
  formReady: boolean;
  canActivate: boolean;
  updateForm: (patch: Partial<PlatformAiFormState>) => void;
  chooseProvider: (provider: PlatformAiProviderChoice) => void;
  retryLoad: () => void;
  saveAndTest: () => Promise<void>;
  activate: () => Promise<void>;
}

export const OFFICIAL_AI_PROVIDERS = {
  openai: {
    label: "OpenAI",
    protocol: "openai-compatible",
    endpoint: "https://api.openai.com/v1",
  },
  anthropic: {
    label: "Anthropic Claude",
    protocol: "anthropic-messages",
    endpoint: "https://api.anthropic.com",
  },
  gemini: {
    label: "Google Gemini",
    protocol: "gemini-generate-content",
    endpoint: "https://generativelanguage.googleapis.com",
  },
} satisfies Record<
  Exclude<PlatformAiProviderChoice, "custom">,
  {
    label: string;
    protocol: ManagedPlatformRouterConfig["protocol"];
    endpoint: string;
  }
>;

const DEFAULT_FORM: PlatformAiFormState = {
  provider: "openai",
  endpoint: OFFICIAL_AI_PROVIDERS.openai.endpoint,
  model: "",
  protocol: OFFICIAL_AI_PROVIDERS.openai.protocol,
  apiKey: "",
  showApiKey: false,
  assistantInstructions: "",
  assistantMaxOutputTokens: "320",
  assistantTemperature: "0.2",
  assistantMaxSteps: "3",
  assistantTimeoutMs: "20000",
  assistantReasoningEffort: "none",
};

const EMPTY_MANAGED_STATE: PlatformAiManagedState = {
  config: null,
  draft: null,
  effective: null,
};

export function usePlatformAiConfiguration({
  canEdit,
  onNotice,
}: {
  canEdit: boolean;
  onNotice: (message: string) => void;
}): PlatformAiConfigurationController {
  const [form, setForm] = useState<PlatformAiFormState>(DEFAULT_FORM);
  const [managed, setManaged] =
    useState<PlatformAiManagedState>(EMPTY_MANAGED_STATE);
  const [asyncState, setAsyncState] = useState<PlatformAiAsyncState>({
    loading: true,
    loadError: null,
    action: "idle",
    feedback: null,
    reloadVersion: 0,
  });
  const savedEditable = managed.draft ?? managed.config;
  const interactionLocked = isInteractionLocked(asyncState);
  const reasoningEfforts = useMemo(
    () => availableReasoningEfforts(savedEditable, form.model),
    [form.model, savedEditable],
  );
  const hasUnsavedChanges = useMemo(
    () => formHasUnsavedChanges(form, savedEditable),
    [form, savedEditable],
  );
  const savedCredentialFitsConnection = credentialFitsConnection(
    savedEditable,
    form,
  );
  const formReady = isFormReady(form, savedCredentialFitsConnection);
  const canActivate = draftCanActivate(
    managed.draft,
    hasUnsavedChanges,
  );

  const updateForm = useCallback(
    (patch: Partial<PlatformAiFormState>) => {
      setForm((current) => ({ ...current, ...patch }));
    },
    [],
  );

  const applyConfig = useCallback((current: ManagedPlatformRouterConfig) => {
    setForm({
      provider: providerFor(current),
      endpoint: current.endpoint,
      model: current.model,
      protocol: current.protocol,
      apiKey: "",
      showApiKey: false,
      assistantInstructions: current.assistantInstructions ?? "",
      assistantMaxOutputTokens: String(
        current.assistantMaxOutputTokens ?? 320,
      ),
      assistantTemperature: String(current.assistantTemperature ?? 0.2),
      assistantMaxSteps: String(current.assistantMaxSteps ?? 3),
      assistantTimeoutMs: String(current.assistantTimeoutMs ?? 20_000),
      assistantReasoningEffort:
        current.assistantReasoningEffort ?? "none",
    });
  }, []);

  const applyServerState = useCallback(
    (state: {
      config: ManagedPlatformRouterConfig | null;
      draft: ManagedPlatformRouterDraftConfig | null;
      effective: PlatformRouterEffectiveStatus;
    }) => {
      setManaged(state);
    },
    [],
  );

  useManagedConfigurationLoad({
    reloadVersion: asyncState.reloadVersion,
    onNotice,
    applyConfig,
    applyServerState,
    setAsyncState,
  });

  const chooseProvider = useCallback((next: PlatformAiProviderChoice) => {
    setAsyncState((current) => ({ ...current, feedback: null }));
    setForm((current) => {
      if (next === "custom") return { ...current, provider: next };
      const preset = OFFICIAL_AI_PROVIDERS[next];
      const protocolChanged = current.protocol !== preset.protocol;
      const connectionChanged =
        protocolChanged || current.endpoint !== preset.endpoint;
      return {
        ...current,
        provider: next,
        endpoint: preset.endpoint,
        protocol: preset.protocol,
        model: protocolChanged ? "" : current.model,
        apiKey: connectionChanged ? "" : current.apiKey,
        showApiKey: connectionChanged ? false : current.showApiKey,
        assistantReasoningEffort: protocolChanged
          ? "none"
          : current.assistantReasoningEffort,
      };
    });
  }, []);

  const retryLoad = useCallback(() => {
    setAsyncState((current) => ({
      ...current,
      reloadVersion: current.reloadVersion + 1,
    }));
  }, []);

  const saveAndTest = useSaveAndTestAction({
    canEdit,
    formReady,
    interactionLocked,
    form,
    reasoningEfforts,
    applyConfig,
    applyServerState,
    setAsyncState,
    onNotice,
  });
  const activate = useActivateConfigurationAction({
    canEdit,
    canActivate,
    interactionLocked,
    applyConfig,
    applyServerState,
    setAsyncState,
    onNotice,
  });

  return {
    canEdit,
    form,
    managed,
    async: asyncState,
    reasoningEfforts,
    interactionLocked,
    savedCredentialFitsConnection,
    hasUnsavedChanges,
    formReady,
    canActivate,
    updateForm,
    chooseProvider,
    retryLoad,
    saveAndTest,
    activate,
  };
}

type AsyncStateSetter = Dispatch<SetStateAction<PlatformAiAsyncState>>;
type ApplyConfig = (config: ManagedPlatformRouterConfig) => void;
type ApplyServerState = (state: {
  config: ManagedPlatformRouterConfig | null;
  draft: ManagedPlatformRouterDraftConfig | null;
  effective: PlatformRouterEffectiveStatus;
}) => void;

function useManagedConfigurationLoad({
  reloadVersion,
  onNotice,
  applyConfig,
  applyServerState,
  setAsyncState,
}: {
  reloadVersion: number;
  onNotice: (message: string) => void;
  applyConfig: ApplyConfig;
  applyServerState: ApplyServerState;
  setAsyncState: AsyncStateSetter;
}) {
  useEffect(() => {
    let mounted = true;
    setAsyncState((current) => ({
      ...current,
      loading: true,
      loadError: null,
    }));
    void getManagedPlatformRouterState()
      .then((state) => {
        if (!mounted) return;
        applyServerState(state);
        const editable = state.draft ?? state.config;
        if (editable) applyConfig(editable);
      })
      .catch((error) => {
        if (!mounted) return;
        const message =
          error instanceof Error ? error.message : "AI 配置读取失败";
        setAsyncState((current) => ({
          ...current,
          loadError: message,
        }));
        onNotice(message);
      })
      .finally(() => {
        if (!mounted) return;
        setAsyncState((current) => ({ ...current, loading: false }));
      });
    return () => {
      mounted = false;
    };
  }, [
    applyConfig,
    applyServerState,
    onNotice,
    reloadVersion,
    setAsyncState,
  ]);
}

function useSaveAndTestAction({
  canEdit,
  formReady,
  interactionLocked,
  form,
  reasoningEfforts,
  applyConfig,
  applyServerState,
  setAsyncState,
  onNotice,
}: {
  canEdit: boolean;
  formReady: boolean;
  interactionLocked: boolean;
  form: PlatformAiFormState;
  reasoningEfforts: string[];
  applyConfig: ApplyConfig;
  applyServerState: ApplyServerState;
  setAsyncState: AsyncStateSetter;
  onNotice: (message: string) => void;
}): () => Promise<void> {
  return useCallback(async () => {
    if (!canEdit || !formReady || interactionLocked) return;
    setAsyncState((current) => ({
      ...current,
      action: "save-test",
      feedback: { tone: "working", text: "正在安全保存并测试连接…" },
    }));
    try {
      const staged = await saveManagedPlatformRouterConfig({
        endpoint: form.endpoint.trim(),
        model: form.model.trim(),
        protocol: form.protocol,
        enabled: true,
        apiKey: form.apiKey.trim() || undefined,
        assistantInstructions: form.assistantInstructions,
        assistantMaxOutputTokens: Number.parseInt(
          form.assistantMaxOutputTokens,
          10,
        ),
        assistantTemperature: Number.parseFloat(
          form.assistantTemperature,
        ),
        assistantMaxSteps: Number.parseInt(form.assistantMaxSteps, 10),
        assistantTimeoutMs: Number.parseInt(form.assistantTimeoutMs, 10),
        assistantReasoningEffort: form.assistantReasoningEffort,
        modelReasoningEfforts: reasoningEfforts,
      });
      applyServerState(staged);
      if (staged.draft) applyConfig(staged.draft);

      const result = await testPlatformAi({ candidate: true });
      applyServerState({
        config: result.config,
        draft: result.draft,
        effective: result.effective,
      });
      if (result.draft) applyConfig(result.draft);
      const passed = result.status === "ready";
      const message = passed
        ? committedNotice("连接测试通过，可以应用到生产", result)
        : result.message;
      setAsyncState((current) => ({
        ...current,
        feedback: {
          tone: passed ? "success" : "error",
          text: message,
        },
      }));
      onNotice(message);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "AI 配置保存或测试失败";
      setAsyncState((current) => ({
        ...current,
        feedback: { tone: "error", text: message },
      }));
      onNotice(message);
    } finally {
      setAsyncState((current) => ({ ...current, action: "idle" }));
    }
  }, [
    applyConfig,
    applyServerState,
    canEdit,
    form,
    formReady,
    interactionLocked,
    onNotice,
    reasoningEfforts,
    setAsyncState,
  ]);
}

function useActivateConfigurationAction({
  canEdit,
  canActivate,
  interactionLocked,
  applyConfig,
  applyServerState,
  setAsyncState,
  onNotice,
}: {
  canEdit: boolean;
  canActivate: boolean;
  interactionLocked: boolean;
  applyConfig: ApplyConfig;
  applyServerState: ApplyServerState;
  setAsyncState: AsyncStateSetter;
  onNotice: (message: string) => void;
}): () => Promise<void> {
  return useCallback(async () => {
    if (!canEdit || !canActivate || interactionLocked) return;
    setAsyncState((current) => ({
      ...current,
      action: "activate",
      feedback: { tone: "working", text: "正在应用已测试配置…" },
    }));
    try {
      const state = await activateManagedPlatformRouterConfig();
      applyServerState(state);
      if (state.config) applyConfig(state.config);
      const message = committedNotice(
        "配置已应用，AI 导购现已使用这套连接",
        state,
      );
      setAsyncState((current) => ({
        ...current,
        feedback: { tone: "success", text: message },
      }));
      onNotice(message);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "AI 配置应用失败";
      setAsyncState((current) => ({
        ...current,
        feedback: { tone: "error", text: message },
      }));
      onNotice(message);
    } finally {
      setAsyncState((current) => ({ ...current, action: "idle" }));
    }
  }, [
    applyConfig,
    applyServerState,
    canActivate,
    canEdit,
    interactionLocked,
    onNotice,
    setAsyncState,
  ]);
}

function isInteractionLocked(state: PlatformAiAsyncState): boolean {
  return state.loading || state.action !== "idle";
}

function availableReasoningEfforts(
  saved: ManagedPlatformRouterConfig | null,
  model: string,
): string[] {
  return saved?.model === model ? saved.modelReasoningEfforts : [];
}

function formHasUnsavedChanges(
  form: PlatformAiFormState,
  saved: ManagedPlatformRouterConfig | null,
): boolean {
  if (!saved || form.apiKey.trim()) return true;
  return editableFingerprint(form) !== editableFingerprint(saved);
}

function credentialFitsConnection(
  saved: ManagedPlatformRouterConfig | null,
  form: PlatformAiFormState,
): boolean {
  return Boolean(
    saved?.credentialConfigured &&
      saved.protocol === form.protocol &&
      saved.endpoint.trim() === form.endpoint.trim(),
  );
}

function isFormReady(
  form: PlatformAiFormState,
  savedCredentialFitsConnection: boolean,
): boolean {
  const hasCredential = Boolean(
    form.apiKey.trim() || savedCredentialFitsConnection,
  );
  return (
    Boolean(form.endpoint.trim() && form.model.trim() && hasCredential) &&
    validInteger(form.assistantMaxOutputTokens, 64, 512) &&
    validNumber(form.assistantTemperature, 0, 1) &&
    validInteger(form.assistantMaxSteps, 2, 8) &&
    validInteger(form.assistantTimeoutMs, 4_000, 30_000)
  );
}

function draftCanActivate(
  draft: ManagedPlatformRouterDraftConfig | null,
  hasUnsavedChanges: boolean,
): boolean {
  return Boolean(draft?.testedReady && !hasUnsavedChanges && draft.enabled);
}

function editableFingerprint(
  value: ManagedPlatformRouterConfig | PlatformAiFormState,
): string {
  return JSON.stringify({
    endpoint: value.endpoint.trim(),
    model: value.model.trim(),
    protocol: value.protocol,
    enabled: true,
    assistantInstructions: value.assistantInstructions ?? "",
    assistantMaxOutputTokens: Number(value.assistantMaxOutputTokens ?? 320),
    assistantTemperature: Number(value.assistantTemperature ?? 0.2),
    assistantMaxSteps: Number(value.assistantMaxSteps ?? 3),
    assistantTimeoutMs: Number(value.assistantTimeoutMs ?? 20_000),
    assistantReasoningEffort: value.assistantReasoningEffort ?? "none",
  });
}

function providerFor(
  current: ManagedPlatformRouterConfig,
): PlatformAiProviderChoice {
  const normalizedEndpoint = current.endpoint.replace(/\/+$/, "");
  for (const [choice, preset] of Object.entries(
    OFFICIAL_AI_PROVIDERS,
  ) as Array<
    [
      Exclude<PlatformAiProviderChoice, "custom">,
      (typeof OFFICIAL_AI_PROVIDERS)["openai"],
    ]
  >) {
    if (
      current.protocol === preset.protocol &&
      normalizedEndpoint === preset.endpoint.replace(/\/+$/, "")
    ) {
      return choice;
    }
  }
  return "custom";
}

function validInteger(value: string, min: number, max: number): boolean {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max;
}

function validNumber(value: string, min: number, max: number): boolean {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max;
}

function committedNotice(
  normal: string,
  mutation: { auditPending?: boolean; maintenancePending?: boolean },
): string {
  const pending = [
    mutation.auditPending ? "审计待重放" : null,
    mutation.maintenancePending ? "后台清理待完成" : null,
  ].filter((item): item is string => item !== null);
  return pending.length ? `已提交，${pending.join("；")}` : normal;
}

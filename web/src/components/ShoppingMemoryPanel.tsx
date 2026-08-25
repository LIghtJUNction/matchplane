"use client";

import {
  type SyntheticEvent,
  useCallback,
  useEffect,
  useId,
  useState,
} from "react";
import {
  Brain,
  LoaderCircle,
  Pause,
  Send,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Button } from "@appica/ui-react/button";
import { Textarea } from "@appica/ui-react/textarea";

import {
  deleteShoppingMemory,
  getShoppingMemory,
  reviseShoppingMemory,
  saveShoppingMemory,
} from "../api";
import type {
  ShoppingMemoryFact,
  ShoppingMemorySnapshot,
} from "../shopping-memory-contract";
import { WorkspaceSettingsDialog } from "./WorkspaceSettingsDialog";

interface ShoppingMemoryPanelProps {
  open: boolean;
  onClose: () => void;
  locale?: "zh" | "en";
  onNotice?: (message: string) => void;
}

interface RevisionMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

type MemorySection = "summary" | "revise" | "data";

const factOrder: ShoppingMemoryFact["kind"][] = [
  "budget",
  "purpose",
  "preference",
  "exclusion",
];

export function ShoppingMemoryPanel({
  open,
  onClose,
  locale = "zh",
  onNotice,
}: ShoppingMemoryPanelProps) {
  const copy = memoryCopy(locale);
  const suggestionId = useId();
  const [activeSection, setActiveSection] = useState<MemorySection>("summary");
  const [memory, setMemory] = useState<ShoppingMemorySnapshot | null>(null);
  const [suggestion, setSuggestion] = useState("");
  const [conversation, setConversation] = useState<RevisionMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState<"toggle" | "revise" | "delete" | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setMemory(await getShoppingMemory());
    } catch (cause) {
      setMemory(null);
      setError(cause instanceof Error ? cause.message : copy.loadFailed);
    } finally {
      setLoading(false);
    }
  }, [copy.loadFailed]);

  useEffect(() => {
    if (!open) return;
    setActiveSection("summary");
    setSuggestion("");
    setConversation([]);
    setConfirmDelete(false);
    setFeedback("");
    void load();
  }, [load, open]);

  async function toggleAutomation() {
    if (!memory || working) return;
    setWorking("toggle");
    setError("");
    setFeedback("");
    try {
      const updated = await saveShoppingMemory({
        enabled: !memory.enabled,
        facts: memory.facts,
        expectedVersion: memory.version,
      });
      setMemory(updated);
      const message = updated.enabled ? copy.resumed : copy.paused;
      setFeedback(message);
      onNotice?.(message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.saveFailed);
    } finally {
      setWorking(null);
    }
  }

  async function askAiToRevise(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = suggestion.trim();
    if (!memory || !request || working) return;
    const userMessage: RevisionMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text: request,
    };
    setConversation((current) => [...current, userMessage]);
    setSuggestion("");
    setWorking("revise");
    setError("");
    setFeedback("");
    try {
      const result = await reviseShoppingMemory({
        suggestion: request,
        expectedVersion: memory.version,
      });
      setMemory(result.memory);
      setConversation((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: result.message,
        },
      ]);
      onNotice?.(result.message);
    } catch (cause) {
      setSuggestion(request);
      setError(cause instanceof Error ? cause.message : copy.revisionFailed);
    } finally {
      setWorking(null);
    }
  }

  async function removeAll() {
    if (!memory || working) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      setFeedback(copy.deleteConfirmHint);
      return;
    }
    setWorking("delete");
    setError("");
    setFeedback("");
    try {
      const cleared = await deleteShoppingMemory();
      setMemory(cleared);
      setConversation((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          text: copy.deleted,
        },
      ]);
      setConfirmDelete(false);
      onNotice?.(copy.deleted);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.deleteFailed);
    } finally {
      setWorking(null);
    }
  }

  const facts = memory
    ? [...memory.facts].sort(
        (left, right) =>
          factOrder.indexOf(left.kind) - factOrder.indexOf(right.kind),
      )
    : [];

  return (
    <WorkspaceSettingsDialog
      open={open}
      onClose={onClose}
      title={copy.title}
      closeLabel={copy.close}
      backdropLabel={copy.closeDialog}
      className="shopping-memory-dialog"
      navigation={[
        {
          id: "summary",
          label: locale === "en" ? "Summary" : "记忆摘要",
          icon: Brain,
        },
        {
          id: "revise",
          label: locale === "en" ? "Revise with AI" : "修改记忆",
          icon: Send,
        },
        {
          id: "data",
          label: locale === "en" ? "Data controls" : "数据管理",
          icon: Trash2,
        },
      ]}
      navigationLabel={locale === "en" ? "Memory settings" : "记忆设置"}
      activeNavigationId={activeSection}
      onNavigationChange={(id) => setActiveSection(id as MemorySection)}
    >
      {loading ? (
        <div className="shopping-memory-loading" role="status">
          <LoaderCircle size={18} className="spin" aria-hidden="true" />
          <span>{copy.loading}</span>
        </div>
      ) : memory ? (
        <div
          className="shopping-memory-panel"
          data-active-section={activeSection}
        >
          <section
            className="shopping-memory-automation"
            aria-label={copy.automationTitle}
            hidden={activeSection !== "summary"}
          >
            <div className="shopping-memory-automation-icon" aria-hidden="true">
              {memory.enabled ? <Brain size={18} /> : <Pause size={18} />}
            </div>
            <div>
              <strong>{copy.automationTitle}</strong>
              <small>
                {memory.enabled ? copy.automationOn : copy.automationOff}
              </small>
            </div>
            <button
              type="button"
              className="shopping-memory-toggle"
              role="switch"
              aria-checked={memory.enabled}
              disabled={Boolean(working)}
              onClick={() => void toggleAutomation()}
            >
              {working === "toggle" ? (
                <LoaderCircle size={15} className="spin" aria-hidden="true" />
              ) : (
                <span
                  className="shopping-memory-switch-track"
                  aria-hidden="true"
                >
                  <span />
                </span>
              )}
              <span className="sr-only">
                {memory.enabled ? copy.pause : copy.resume}
              </span>
            </button>
          </section>

          <section
            className="shopping-memory-summary"
            aria-labelledby="shopping-memory-summary-title"
            hidden={activeSection !== "summary"}
          >
            <div className="shopping-memory-section-heading">
              <div>
                <span className="eyebrow">{copy.summaryEyebrow}</span>
                <h3 id="shopping-memory-summary-title">{copy.summaryTitle}</h3>
              </div>
              {memory.updatedAt ? (
                <time dateTime={memory.updatedAt}>
                  {copy.updated} {formatUpdatedAt(memory.updatedAt, locale)}
                </time>
              ) : null}
            </div>
            {facts.length ? (
              <dl className="shopping-memory-facts">
                {facts.map((fact) => (
                  <div key={`${fact.kind}:${fact.key}`}>
                    <dt>{factLabel(fact.kind, locale)}</dt>
                    <dd>{factValue(fact, locale)}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <div className="shopping-memory-empty">
                <Sparkles size={18} aria-hidden="true" />
                <div>
                  <strong>{copy.emptyTitle}</strong>
                  <p>{copy.emptyBody}</p>
                </div>
              </div>
            )}
          </section>

          <section
            className="shopping-memory-assistant"
            aria-labelledby="shopping-memory-assistant-title"
            hidden={activeSection !== "revise"}
          >
            <div className="shopping-memory-section-heading">
              <div>
                <span className="eyebrow">{copy.reviseEyebrow}</span>
                <h3 id="shopping-memory-assistant-title">{copy.reviseTitle}</h3>
              </div>
            </div>
            {conversation.length ? (
              <div
                className="shopping-memory-conversation"
                role="log"
                aria-live="polite"
                aria-label={copy.revisionConversation}
              >
                {conversation.map((item) => (
                  <p key={item.id} className={`is-${item.role}`}>
                    {item.text}
                  </p>
                ))}
              </div>
            ) : (
              <p className="shopping-memory-assistant-hint">
                {copy.reviseHint}
              </p>
            )}
            <form
              className="shopping-memory-revision-form"
              onSubmit={askAiToRevise}
            >
              <label htmlFor={suggestionId}>{copy.suggestionLabel}</label>
              <Textarea
                id={suggestionId}
                value={suggestion}
                rows={3}
                maxLength={2_000}
                placeholder={copy.suggestionPlaceholder}
                disabled={Boolean(working)}
                onChange={(event) => setSuggestion(event.target.value)}
              />
              <div>
                <small>{copy.suggestionPrivacy}</small>
                <Button
                  type="submit"
                  disabled={Boolean(working) || !suggestion.trim()}
                >
                  {working === "revise" ? (
                    <LoaderCircle
                      size={16}
                      className="spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <Send size={16} aria-hidden="true" />
                  )}
                  {working === "revise" ? copy.revising : copy.reviseAction}
                </Button>
              </div>
            </form>
          </section>

          <div className="shopping-memory-feedback" aria-live="polite">
            {error ? (
              <div className="is-error" role="alert">
                <span>{error}</span>
                <button
                  type="button"
                  onClick={() => void load()}
                  disabled={Boolean(working)}
                >
                  {copy.retry}
                </button>
              </div>
            ) : feedback ? (
              <p role="status">{feedback}</p>
            ) : null}
          </div>

          <div
            className="shopping-memory-footer"
            hidden={activeSection !== "data"}
          >
            <div>
              <strong>
                {locale === "en" ? "Clear memory" : "清除购物记忆"}
              </strong>
              <small>
                {locale === "en"
                  ? "Remove the saved summary without deleting your account."
                  : "仅删除已保存的购物摘要，不会删除账号。"}
              </small>
            </div>
            <Button
              type="button"
              variant="outline"
              className={confirmDelete ? "is-confirming" : undefined}
              disabled={Boolean(working)}
              onClick={() => void removeAll()}
            >
              {working === "delete" ? (
                <LoaderCircle size={16} className="spin" aria-hidden="true" />
              ) : (
                <Trash2 size={16} aria-hidden="true" />
              )}
              {confirmDelete ? copy.deleteConfirm : copy.deleteAll}
            </Button>
          </div>
        </div>
      ) : (
        <div className="shopping-memory-load-error" role="alert">
          <p>{error || copy.loadFailed}</p>
          <Button type="button" variant="outline" onClick={() => void load()}>
            {copy.retry}
          </Button>
        </div>
      )}
    </WorkspaceSettingsDialog>
  );
}

function factLabel(kind: ShoppingMemoryFact["kind"], locale: "zh" | "en") {
  const labels = {
    zh: {
      budget: "预算上限",
      purpose: "主要用途",
      preference: "稳定偏好",
      exclusion: "排除项",
    },
    en: {
      budget: "Budget ceiling",
      purpose: "Main use",
      preference: "Stable preferences",
      exclusion: "Avoid",
    },
  } as const;
  return labels[locale][kind];
}

function factValue(fact: ShoppingMemoryFact, locale: "zh" | "en") {
  if (fact.kind !== "budget") return fact.value;
  const amount = Number(fact.value);
  if (!Number.isFinite(amount)) return fact.value;
  return new Intl.NumberFormat(locale === "en" ? "en-US" : "zh-CN", {
    style: "currency",
    currency: fact.currency ?? "CNY",
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatUpdatedAt(value: string, locale: "zh" | "en") {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale === "en" ? "en" : "zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function memoryCopy(locale: "zh" | "en") {
  return locale === "en"
    ? {
        title: "Shopping memory",
        description:
          "AI summarizes durable shopping needs. You can review, correct, pause, or clear them at any time.",
        close: "Close shopping memory",
        closeDialog: "Close shopping memory dialog",
        loading: "Loading memory…",
        loadFailed: "Shopping memory could not be loaded.",
        saveFailed: "The setting could not be saved.",
        revisionFailed: "AI could not revise the memory.",
        deleteFailed: "The memory could not be deleted.",
        automationTitle: "AI automatic summary",
        automationOn:
          "New durable needs from shopping conversations may update this summary.",
        automationOff: "AI will not read or update these facts while paused.",
        pause: "Pause",
        resume: "Resume",
        paused: "Automatic memory is paused.",
        resumed: "Automatic memory is active.",
        summaryEyebrow: "What AI remembers",
        summaryTitle: "Current summary",
        updated: "Updated",
        emptyTitle: "Nothing summarized yet",
        emptyBody:
          "Tell the shopping assistant what you need, or give the memory assistant a suggestion below.",
        reviseEyebrow: "Review with AI",
        reviseTitle: "Suggest a change",
        reviseHint:
          "Describe a correction naturally. AI will update the structured summary and tell you what changed.",
        revisionConversation: "Memory revision conversation",
        suggestionLabel: "Your suggestion",
        suggestionPlaceholder:
          "For example: change my budget to ¥8,000 and remove the brand preference",
        suggestionPrivacy:
          "Only durable shopping needs belong here—never passwords, contacts, addresses, or payment details.",
        revising: "Updating…",
        reviseAction: "Ask AI to update",
        retry: "Try again",
        deleteAll: "Clear all memory",
        deleteConfirm: "Confirm clear",
        deleteConfirmHint:
          "Select confirm clear again to permanently remove this summary.",
        deleted:
          "All shopping memory was cleared. AI can build a new summary from future conversations.",
      }
    : {
        title: "购物记忆",
        description:
          "自动记下长期购物需求；你可以随时查看、纠正、暂停或清空。",
        close: "关闭购物记忆",
        closeDialog: "关闭购物记忆弹窗",
        loading: "正在读取记忆…",
        loadFailed: "暂时无法读取购物记忆。",
        saveFailed: "暂时无法保存设置。",
        revisionFailed: "暂时无法修改购物记忆。",
        deleteFailed: "暂时无法删除购物记忆。",
        automationTitle: "自动总结",
        automationOn: "购物对话中出现新的长期需求时，会自动更新这份摘要。",
        automationOff: "暂停期间，不会读取或更新这些内容。",
        pause: "暂停",
        resume: "恢复",
        paused: "已暂停自动记忆。",
        resumed: "已恢复自动记忆。",
        summaryEyebrow: "已记住的需求",
        summaryTitle: "当前摘要",
        updated: "更新于",
        emptyTitle: "还没有形成记忆",
        emptyBody: "继续在找商品里聊聊需求，或直接在下面写下要记住的内容。",
        reviseEyebrow: "核对与修改",
        reviseTitle: "提出修改建议",
        reviseHint:
          "像聊天一样说明要改什么；摘要会随之更新，并告诉你实际改动。",
        revisionConversation: "购物记忆修改对话",
        suggestionLabel: "说明要修改的内容",
        suggestionPlaceholder: "例如：预算改成 8000 元，并删除品牌偏好",
        suggestionPrivacy:
          "这里只保留长期购物需求，请勿填写密码、联系方式、地址或支付信息。",
        revising: "正在更新…",
        reviseAction: "提交修改",
        retry: "重试",
        deleteAll: "清空全部记忆",
        deleteConfirm: "确认清空",
        deleteConfirmHint: "再次点击“确认清空”后，这份摘要会被永久删除。",
        deleted: "购物记忆已全部清空；后续对话可以重新形成摘要。",
      };
}

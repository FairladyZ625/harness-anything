import { useEffect, useId, useState, type ReactNode } from "react";
import { ArrowClockwise, CheckCircle, CircleNotch, WarningCircle } from "@phosphor-icons/react";
import { CopyContextButton } from "../CopyContextButton.tsx";
import { Button } from "../primitives/Button.tsx";
import { formatDuration } from "../../model/time.ts";
import { t, type MessageKey } from "../../i18n/index.tsx";

/**
 * agent-ui 工具调用可观测原语(dec_C0AF8CBBFFECF71F4F34FB76F9 CH2):
 * 单行紧凑工具调用卡 + 同轮多次调用折叠组(Affect UI ToolCallCard / ToolCallGroup 契约)。
 * 自包含 props 驱动,不绑定 daemon;W2 会话视图接入领域事件流。
 */

export type ToolCallStatus = "running" | "succeeded" | "failed";

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** 一句话摘要(单行截断展示)。 */
  readonly summary: string;
  readonly status: ToolCallStatus;
  /** ISO 开始时间;running 且无 durationMs 时按它与当前时间出实时耗时。 */
  readonly startedAt?: string;
  /** 已结束调用的耗时毫秒;running 时可缺省。 */
  readonly durationMs?: number | null;
  /** 原始参数文本(通常为 JSON 字符串,允许超大负载,展示层截断)。 */
  readonly arguments?: string | null;
  /** 原始返回文本(允许超大负载,展示层截断)。 */
  readonly result?: string | null;
  /** 失败时的错误摘要。 */
  readonly error?: string | null;
}

/** 展示层截断上限:预览最多渲染这么多字符,复制始终给完整原文(任务约束:严禁直接渲染超大字符串)。 */
export const DEFAULT_PAYLOAD_PREVIEW_LIMIT = 2_000;

const STATUS_META: Record<ToolCallStatus, { readonly labelKey: MessageKey; readonly className: string }> = {
  running: { labelKey: "agentUi.toolcall.status.running", className: "text-status-active" },
  succeeded: { labelKey: "agentUi.toolcall.status.succeeded", className: "text-success" },
  failed: { labelKey: "agentUi.toolcall.status.failed", className: "text-danger" },
};

function StatusIcon({ status }: { readonly status: ToolCallStatus }): ReactNode {
  if (status === "running")
    return (
      <CircleNotch
        weight="bold"
        size="0.875em"
        aria-hidden
        className={`animate-spin ${STATUS_META.running.className}`}
      />
    );
  if (status === "succeeded")
    return <CheckCircle weight="bold" size="0.875em" aria-hidden className={STATUS_META.succeeded.className} />;
  return <WarningCircle weight="bold" size="0.875em" aria-hidden className={STATUS_META.failed.className} />;
}

/** running 态的实时耗时需要一个 1s 心跳;其余状态不启定时器。 */
function useNowMs(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function elapsedLabel(call: ToolCall, nowMs: number): string {
  if (typeof call.durationMs === "number" && Number.isFinite(call.durationMs)) {
    return formatDuration(call.durationMs);
  }
  if (call.status === "running" && call.startedAt !== undefined) {
    const started = Date.parse(call.startedAt);
    if (Number.isFinite(started)) return formatDuration(Math.max(0, nowMs - started));
  }
  return "—";
}

export interface PayloadPreview {
  readonly text: string;
  readonly totalLength: number;
  readonly truncated: boolean;
}

/** 超大负载只渲染前 limit 个字符;截断信息随预览一起返回。 */
export function truncatePayload(text: string, limit: number = DEFAULT_PAYLOAD_PREVIEW_LIMIT): PayloadPreview {
  if (text.length <= limit) return { text, totalLength: text.length, truncated: false };
  return { text: text.slice(0, limit), totalLength: text.length, truncated: true };
}

const JSON_TOKEN_RE =
  /"(?:[^"\\]|\\.)*"\s*:|"(?:[^"\\]|\\.)*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g;

/** 轻量 JSON 着色:不 parse(超大负载 parse 本身就贵且可能抛),按词法着色,截断文本同样适用。 */
function HighlightedJson({ text }: { readonly text: string }): ReactNode {
  const nodes: ReactNode[] = [];
  const regex = new RegExp(JSON_TOKEN_RE.source, "g");
  let cursor = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    // 词法档位:key=青蓝强调、字符串=绿、数字=琥珀、字面量=橙(独立于状态色,只做可读性分层)。
    const className = token.endsWith(":")
      ? "text-accent"
      : token.startsWith('"')
        ? "text-success"
        : token === "true" || token === "false" || token === "null"
          ? "text-agent-question"
          : "text-status-submitted";
    nodes.push(
      <span key={key++} className={className}>
        {token}
      </span>,
    );
    cursor = match.index + token.length;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return <>{nodes}</>;
}

function PayloadBlock({
  title,
  text,
  previewLimit,
  copyLabelKey,
  testId,
}: {
  readonly title: string;
  readonly text: string;
  readonly previewLimit: number;
  readonly copyLabelKey: "agentUi.toolcall.copyArgs" | "agentUi.toolcall.copyResult";
  readonly testId: string;
}): ReactNode {
  const preview = truncatePayload(text, previewLimit);
  return (
    <div data-testid={testId} className="min-w-0">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono ui-micro uppercase tracking-wide text-text-faint">{title}</span>
        <CopyContextButton
          testId={`${testId}-copy`}
          compact
          label={t(copyLabelKey)}
          title={t("agentUi.toolcall.copyFullTip")}
          buildText={() => text}
        />
      </div>
      <pre className="mt-1 max-h-64 overflow-auto rounded-md border border-border bg-surface px-2.5 py-2 font-mono ui-micro leading-relaxed text-text">
        <HighlightedJson text={preview.text} />
        {preview.truncated && (
          <span data-testid={`${testId}-truncated`} className="mt-2 block text-text-faint">
            {t("agentUi.toolcall.truncated", { count: preview.totalLength })}
          </span>
        )}
      </pre>
    </div>
  );
}

export function ToolCallCard({
  call,
  defaultExpanded = false,
  previewLimit = DEFAULT_PAYLOAD_PREVIEW_LIMIT,
  onRetry,
  testId = "toolcall-card",
}: {
  readonly call: ToolCall;
  readonly defaultExpanded?: boolean;
  readonly previewLimit?: number;
  readonly onRetry?: (call: ToolCall) => void;
  readonly testId?: string;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const bodyId = useId();
  const nowMs = useNowMs(call.status === "running" && call.durationMs === undefined);
  return (
    <div
      data-testid={testId}
      data-toolcall-status={call.status}
      className="min-w-0 rounded-lg border border-border bg-surface-raised/40"
    >
      {/* 原生 button:整行折叠头(状态图标/名称/摘要/耗时/箭头同格,aria-expanded+aria-controls),
          是 disclosure 控件不是动作按钮;Button 的动作密度(w-max/边框/feedback)不适用,故保留原生。 */}
      <button
        type="button"
        data-testid={`${testId}-toggle`}
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-surface"
      >
        <StatusIcon status={call.status} />
        <span className="shrink-0 font-mono ui-meta font-semibold text-text">{call.name}</span>
        <span className="min-w-0 flex-1 truncate ui-meta text-text-muted">{call.summary}</span>
        <span
          data-testid={`${testId}-elapsed`}
          className="shrink-0 font-mono ui-micro tabular-nums text-text-faint"
          title={t(STATUS_META[call.status].labelKey)}
        >
          {elapsedLabel(call, nowMs)}
        </span>
        <span aria-hidden className="shrink-0 font-mono ui-micro text-text-faint">
          {expanded ? "▾" : "▸"}
        </span>
      </button>
      {expanded && (
        <div
          id={bodyId}
          role="region"
          aria-label={t("agentUi.toolcall.detailAria", { name: call.name })}
          className="flex flex-col gap-2.5 border-t border-border px-2.5 py-2.5"
        >
          {(call.arguments ?? "") !== "" && (
            <PayloadBlock
              testId={`${testId}-arguments`}
              title={t("agentUi.toolcall.argumentsTitle")}
              text={call.arguments ?? ""}
              previewLimit={previewLimit}
              copyLabelKey="agentUi.toolcall.copyArgs"
            />
          )}
          {(call.result ?? "") !== "" && (
            <PayloadBlock
              testId={`${testId}-result`}
              title={t("agentUi.toolcall.resultTitle")}
              text={call.result ?? ""}
              previewLimit={previewLimit}
              copyLabelKey="agentUi.toolcall.copyResult"
            />
          )}
          {call.status === "failed" && (
            <div
              data-testid={`${testId}-error`}
              className="rounded-md border border-danger/40 px-2.5 py-2 ui-micro text-danger"
            >
              {call.error ?? t("agentUi.toolcall.errorFallback")}
              {onRetry && (
                <Button
                  variant="plain"
                  size="sm"
                  testId={`${testId}-retry`}
                  tip={t("agentUi.toolcall.retryTip")}
                  onClick={() => onRetry(call)}
                >
                  <ArrowClockwise weight="bold" /> {t("agentUi.toolcall.retry")}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 同一轮连续多次工具调用的折叠汇总条:默认一行汇总(如「已调用 6 个工具 · 耗时 1.8s」),
 * 展开后才铺开逐张 ToolCallCard,防止长对话被工具卡片淹没。
 */
export function ToolCallGroup({
  calls,
  defaultExpanded = false,
  previewLimit = DEFAULT_PAYLOAD_PREVIEW_LIMIT,
  onRetry,
  testId = "toolcall-group",
}: {
  readonly calls: readonly ToolCall[];
  readonly defaultExpanded?: boolean;
  readonly previewLimit?: number;
  readonly onRetry?: (call: ToolCall) => void;
  readonly testId?: string;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const bodyId = useId();
  const failedCount = calls.filter((call) => call.status === "failed").length;
  const runningCount = calls.filter((call) => call.status === "running").length;
  const totalMs = calls.reduce(
    (sum, call) =>
      typeof call.durationMs === "number" && Number.isFinite(call.durationMs) ? sum + call.durationMs : sum,
    0,
  );
  const summary = t("agentUi.toolcall.groupSummary", {
    count: calls.length,
    duration: formatDuration(totalMs),
  });
  return (
    <div data-testid={testId} className="min-w-0 rounded-lg border border-border bg-surface-raised/30">
      {/* 原生 button:同卡折叠头,disclosure 控件,理由见 ToolCallCard 折叠头注释。 */}
      <button
        type="button"
        data-testid={`${testId}-toggle`}
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-surface"
      >
        <span aria-hidden className="font-mono ui-micro text-text-faint">
          {expanded ? "▾" : "▸"}
        </span>
        <span data-testid={`${testId}-summary`} className="min-w-0 flex-1 truncate ui-meta text-text-muted">
          {summary}
        </span>
        {runningCount > 0 && (
          <span className="shrink-0 font-mono ui-micro tabular-nums text-status-active">
            {t("agentUi.toolcall.groupRunning", { count: runningCount })}
          </span>
        )}
        {failedCount > 0 && (
          <span className="shrink-0 font-mono ui-micro tabular-nums text-danger">
            {t("agentUi.toolcall.groupFailed", { count: failedCount })}
          </span>
        )}
      </button>
      {expanded && (
        <div
          id={bodyId}
          role="region"
          aria-label={t("agentUi.toolcall.groupAria")}
          className="flex flex-col gap-1.5 border-t border-border px-2 py-2"
        >
          {calls.map((call) => (
            <ToolCallCard key={call.id} call={call} previewLimit={previewLimit} onRetry={onRetry} />
          ))}
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState, type ReactNode, type UIEvent } from "react";
import { consumeKnownError } from "../../../api/error-consumption.ts";
import type { ObserveTailRead } from "../../../api/renderer-dto.ts";
import { harnessClient } from "../../api-client.ts";
import {
  sessionTranscriptTurns,
  toolCallGroups,
  type SessionTranscriptTurn,
  type ToolCallEntry,
  type ToolCallGroup as ToolCallGroupModel,
} from "../../session-transcript-model.ts";
import { t } from "../../i18n/index.tsx";
import { Card, CardBody, CardHead, CardTitle, LiveDot } from "../runtime/parts.tsx";
import { Button } from "../primitives/Button.tsx";
import { StatusTag } from "../primitives/StatusTag.tsx";
import { ToolCallCard, ToolCallGroup } from "../agent-ui/ToolCallCard.tsx";
import { ThinkingState } from "./ThinkingState.tsx";

type DispatchCursorValue = Extract<NonNullable<ObserveTailRead["historyCursor"]>, { readonly kind: "dispatch" }>;
type DispatchCursor = DispatchCursorValue | null;

export function SessionTranscript({
  repoId,
  dispatchId,
  live,
  onSettled,
  title,
  onRetryToolCall,
}: {
  readonly repoId: string;
  readonly dispatchId: string | null;
  readonly live: boolean;
  readonly onSettled: () => void;
  /** 给了标题就自带卡片:加载中或没有记录时整块不渲染(规范 1.5「空了就消失」)。 */
  readonly title?: string;
  readonly onRetryToolCall?: (call: ToolCallEntry) => void;
}) {
  const [records, setRecords] = useState<readonly Readonly<Record<string, unknown>>[]>([]),
    [historyCursor, setHistoryCursor] = useState<DispatchCursor>(null),
    [historyDone, setHistoryDone] = useState(false),
    [loadingHistory, setLoadingHistory] = useState(false),
    [initialized, setInitialized] = useState(dispatchId === null),
    [error, setError] = useState<string | null>(null),
    scrollRef = useRef<HTMLDivElement>(null),
    initialScroll = useRef(false),
    settled = useRef(false);

  useEffect(() => {
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    initialScroll.current = false;
    settled.current = false;
    setRecords([]);
    setHistoryCursor(null);
    setHistoryDone(false);
    setError(null);
    setInitialized(dispatchId === null);
    if (dispatchId === null) return () => void (active = false);

    const follow = async (cursor: DispatchCursorValue) => {
        if (!active || !live) return;
        try {
          const page = await harnessClient.tailObservability({
            repoId,
            kind: "dispatch",
            dispatchId,
            direction: "follow",
            cursor,
          });
          if (!active) return;
          if (page.status === "gap" || page.status === "unavailable") {
            setError(t("agentRuntime.transcriptUnavailable"));
            return;
          }
          const fresh = replayRecords(page.items);
          if (fresh.length > 0) setRecords((current) => mergeRecords(current, fresh, false));
          if (!settled.current && fresh.some(isTerminalRecord)) {
            settled.current = true;
            onSettled();
          }
          const next = dispatchCursor(page.liveCursor);
          if (next) timer = setTimeout(() => void follow(next), page.done ? 1_000 : 0);
        } catch (cause) {
          consumeKnownError(cause);
          if (active) setError(cause instanceof Error ? cause.message : String(cause));
        }
      },
      start = async () => {
        try {
          const page = await harnessClient.tailObservability({
            repoId,
            kind: "dispatch",
            dispatchId,
            direction: "history",
          });
          if (!active) return;
          if (page.status === "gap" || page.status === "unavailable") {
            setError(t("agentRuntime.transcriptUnavailable"));
            setInitialized(true);
            return;
          }
          setRecords(replayRecords(page.items));
          setHistoryCursor(dispatchCursor(page.historyCursor));
          setHistoryDone(page.done);
          setInitialized(true);
          const cursor = dispatchCursor(page.liveCursor);
          if (cursor && live) timer = setTimeout(() => void follow(cursor), 1_000);
        } catch (cause) {
          consumeKnownError(cause);
          if (active) {
            setError(cause instanceof Error ? cause.message : String(cause));
            setInitialized(true);
          }
        }
      };
    void start();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [dispatchId, live, onSettled, repoId]);

  useEffect(() => {
    if (!initialized || initialScroll.current || records.length === 0) return;
    const viewport = scrollRef.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
    initialScroll.current = true;
  }, [initialized, records.length]);

  const loadOlder = useCallback(async () => {
    if (!dispatchId || !historyCursor || historyDone || loadingHistory) return;
    const viewport = scrollRef.current,
      previousHeight = viewport?.scrollHeight ?? 0;
    setLoadingHistory(true);
    try {
      const page = await harnessClient.tailObservability({
        repoId,
        kind: "dispatch",
        dispatchId,
        direction: "history",
        cursor: historyCursor,
      });
      if (page.status === "gap" || page.status === "unavailable") {
        setError(t("agentRuntime.transcriptUnavailable"));
        return;
      }
      setRecords((current) => mergeRecords(current, replayRecords(page.items), true));
      setHistoryCursor(dispatchCursor(page.historyCursor));
      setHistoryDone(page.done);
      requestAnimationFrame(() => {
        const current = scrollRef.current;
        if (current) current.scrollTop += current.scrollHeight - previousHeight;
      });
    } catch (cause) {
      consumeKnownError(cause);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingHistory(false);
    }
  }, [dispatchId, historyCursor, historyDone, loadingHistory, repoId]);

  const turns = sessionTranscriptTurns(records);
  if (title !== undefined && (!initialized || (!error && turns.length === 0))) return null;
  const content = !initialized ? (
    <p className="px-2.5 py-2 ui-micro text-text-faint">{t("agentRuntime.loading")}</p>
  ) : error ? (
    <p role="alert" className="px-2.5 py-2 ui-micro text-status-blocked">
      {error}
    </p>
  ) : turns.length === 0 ? (
    <p data-testid="session-transcript-empty" className="px-2.5 py-2 ui-micro text-text-faint">
      {t("agentRuntime.transcriptNoRecord")}
    </p>
  ) : (
    <div
      ref={scrollRef}
      data-testid="session-transcript"
      onScroll={(event) => onTranscriptScroll(event, loadOlder)}
      // 会话详情是整页滚动流,卡片没有有界高度可分:flex-1 从未生效。改用与结果正文
      // 同一条有界滚动契约(bounded-content,§4.1),长转写在卡内滚动、加载条不再随页滚走。
      className="bounded-content rounded border border-border"
    >
      {!historyDone && (
        <div className="border-b border-border px-2.5 py-1.5 text-center">
          <Button size="sm" disabled={loadingHistory} onClick={() => void loadOlder()}>
            {t(loadingHistory ? "agentRuntime.transcriptLoadingOlder" : "agentRuntime.transcriptLoadOlder")}
          </Button>
        </div>
      )}
      <SessionTranscriptTurns turns={turns} live={live} onRetry={onRetryToolCall} />
      <div
        className={
          "flex items-center gap-1.5 border-t border-border px-2.5 py-1.5 " + "font-mono ui-micro text-text-faint"
        }
      >
        {live ? <span className="rt-pulse" /> : <LiveDot state="idle" />}
        {t(live ? "agentRuntime.transcriptFollowing" : "agentRuntime.transcriptEnded")}
      </div>
    </div>
  );
  if (title === undefined) return content;
  return (
    <Card>
      <CardHead>
        <CardTitle>{title}</CardTitle>
      </CardHead>
      <CardBody>{content}</CardBody>
    </Card>
  );
}

export function SessionTranscriptTurns({
  turns,
  live = false,
  onRetry,
}: {
  readonly turns: readonly SessionTranscriptTurn[];
  readonly live?: boolean;
  readonly onRetry?: (call: ToolCallEntry) => void;
}) {
  return turns.map((turn, index) => {
    const groups = toolCallGroups([turn]);
    const groupByFirstCallKey = new Map<string, ToolCallGroupModel>();
    for (const group of groups) {
      if (group.calls.length > 0) {
        groupByFirstCallKey.set(group.calls[0]!.key, group);
      }
    }

    const elements: ReactNode[] = [];
    for (const item of turn.items) {
      if (item.type === "tool_call") {
        const group = groupByFirstCallKey.get(item.key);
        if (group !== undefined) {
          elements.push(
            <div key={group.key} data-testid="session-transcript-tool_call" className="my-1.5 px-2.5">
              {group.calls.length > 1 ? (
                <ToolCallGroup group={group} onRetry={onRetry} />
              ) : (
                <ToolCallCard call={group.calls[0]!} onRetry={onRetry} />
              )}
            </div>,
          );
        }
        continue;
      }
      if (item.type === "tool_result") {
        // Paired into ToolCallCard result; do not render raw
        continue;
      }
      if (item.type === "thinking") {
        elements.push(
          <div key={item.key} data-testid="session-transcript-thinking" className="my-1.5 px-2.5">
            <ThinkingState thinking={item.detail} summary={item.summary} live={live && turn.status === "running"} />
          </div>,
        );
        continue;
      }
      if (item.type === "text") {
        elements.push(
          <div
            key={item.key}
            data-testid="session-transcript-text"
            className="my-1 px-3 py-1.5 ui-body text-text whitespace-pre-wrap [overflow-wrap:anywhere]"
          >
            {item.detail}
          </div>,
        );
        continue;
      }
      if (item.type === "error") {
        elements.push(
          <div
            key={item.key}
            role="alert"
            data-testid="session-transcript-error"
            className="my-1.5 mx-2.5 rounded-md border border-danger/40 bg-danger/[0.06] px-3 py-2 ui-micro text-danger"
          >
            {item.detail}
          </div>,
        );
      }
    }

    return (
      <details
        key={turn.key}
        data-testid="session-transcript-turn"
        className="border-b border-border last:border-0"
        open
      >
        <summary className="flex cursor-pointer items-center gap-2 px-2.5 py-2 ui-micro hover:bg-panel-soft">
          <span className="font-mono ui-micro text-text-faint">
            {t("agentRuntime.transcriptTurn", { n: index + 1 })}
          </span>
          <StatusTag
            status={turn.status === "completed" ? "done" : turn.status === "failed" ? "blocked" : "active"}
            mono
            label={turn.status}
          />
          <span className="min-w-0 flex-1 truncate text-text-muted">{turn.items.at(-1)?.summary}</span>
          <span className="font-mono ui-micro text-text-faint">{turn.items.length}</span>
        </summary>
        <div className="border-t border-border bg-panel-soft/35 py-1.5">{elements}</div>
      </details>
    );
  });
}

function replayRecords(items: ObserveTailRead["items"]): readonly Readonly<Record<string, unknown>>[] {
  return items.filter(isRecord) as readonly Readonly<Record<string, unknown>>[];
}

function dispatchCursor(value: ObserveTailRead["historyCursor"]): DispatchCursor {
  return value?.kind === "dispatch" ? value : null;
}

function mergeRecords(
  current: readonly Readonly<Record<string, unknown>>[],
  fresh: readonly Readonly<Record<string, unknown>>[],
  prepend: boolean,
): readonly Readonly<Record<string, unknown>>[] {
  // History pages and follow reads are cursor-disjoint by contract; identical adjacent
  // records (repeated item.updated, same-text provider frames) are real and must be kept.
  return prepend ? [...fresh, ...current] : [...current, ...fresh];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTerminalRecord(record: Readonly<Record<string, unknown>>): boolean {
  return record.kind === "process_exit" || (record.kind === "exit_notification" && record.phase === "finished");
}

function onTranscriptScroll(event: UIEvent<HTMLDivElement>, loadOlder: () => Promise<void>): void {
  if (event.currentTarget.scrollTop <= 32) void loadOlder();
}

import { useCallback, useEffect, useRef, useState, type UIEvent } from "react";
import { consumeKnownError } from "../../../api/error-consumption.ts";
import type { ObserveTailRead } from "../../../api/renderer-dto.ts";
import { harnessClient } from "../../api-client.ts";
import {
  sessionTranscriptTurns,
  type SessionTranscriptTurn,
  type SessionTranscriptItemType,
} from "../../session-transcript-model.ts";
import { t } from "../../i18n/index.tsx";
import { Badge, Btn, LiveDot } from "../runtime/parts.tsx";

type DispatchCursorValue = Extract<
  NonNullable<ObserveTailRead["historyCursor"]>,
  { readonly kind: "dispatch" }
>;
type DispatchCursor = DispatchCursorValue | null;

export function SessionTranscript({
  repoId,
  dispatchId,
  live,
  onSettled,
}: {
  readonly repoId: string;
  readonly dispatchId: string | null;
  readonly live: boolean;
  readonly onSettled: () => void;
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
  if (!initialized) return <p className="px-2.5 py-2 text-[10.5px] text-text-faint">{t("agentRuntime.loading")}</p>;
  if (error)
    return (
      <p role="alert" className="px-2.5 py-2 text-[10.5px] text-status-blocked">
        {error}
      </p>
    );
  if (turns.length === 0)
    return (
      <p data-testid="session-transcript-empty" className="px-2.5 py-2 text-[10.5px] text-text-faint">
        {t("agentRuntime.transcriptNoRecord")}
      </p>
    );
  return (
    <div
      ref={scrollRef}
      data-testid="session-transcript"
      onScroll={(event) => onTranscriptScroll(event, loadOlder)}
      className="max-h-[30rem] overflow-y-auto rounded border border-border"
    >
      {!historyDone && (
        <div className="border-b border-border px-2.5 py-1.5 text-center">
          <Btn size="sm" disabled={loadingHistory} onClick={() => void loadOlder()}>
            {t(loadingHistory ? "agentRuntime.transcriptLoadingOlder" : "agentRuntime.transcriptLoadOlder")}
          </Btn>
        </div>
      )}
      <SessionTranscriptTurns turns={turns} />
      <div
        className={
          "flex items-center gap-1.5 border-t border-border px-2.5 py-1.5 " +
          "font-mono text-[10px] text-text-faint"
        }
      >
        {live ? <span className="rt-pulse" /> : <LiveDot state="idle" />}
        {t(live ? "agentRuntime.transcriptFollowing" : "agentRuntime.transcriptEnded")}
      </div>
    </div>
  );
}

export function SessionTranscriptTurns({ turns }: { readonly turns: readonly SessionTranscriptTurn[] }) {
  return turns.map((turn, index) => (
        <details key={turn.key} data-testid="session-transcript-turn" className="border-b border-border last:border-0">
          <summary className="flex cursor-pointer items-center gap-2 px-2.5 py-2 text-[11px] hover:bg-panel-soft">
            <span className="font-mono text-[9px] text-text-faint">
              {t("agentRuntime.transcriptTurn", { n: index + 1 })}
            </span>
            <Badge status={turn.status === "completed" ? "done" : turn.status === "failed" ? "blocked" : "active"}>
              {turn.status}
            </Badge>
            <span className="min-w-0 flex-1 truncate text-text-muted">{turn.items.at(-1)?.summary}</span>
            <span className="font-mono text-[9px] text-text-faint">{turn.items.length}</span>
          </summary>
          <div className="border-t border-border bg-panel-soft/35">
            {turn.items.map((item) => (
              <details
                key={item.key}
                data-testid={`session-transcript-${item.type}`}
                className="border-b border-border/70 last:border-0"
              >
                <summary className="grid cursor-pointer grid-cols-[82px_minmax(0,1fr)] gap-2 px-3 py-1.5 text-[10.5px]">
                  <span className={`font-mono uppercase ${ITEM_TONE[item.type]}`}>
                    {t(ITEM_LABEL[item.type])}
                  </span>
                  <span className="min-w-0 truncate">
                    {item.label === item.type ? item.summary : `${item.label} · ${item.summary}`}
                  </span>
                </summary>
                <pre className="rt-pre mx-3 mb-2 max-h-72 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {item.detail}
                </pre>
              </details>
            ))}
          </div>
        </details>
      ));
}

const ITEM_LABEL: Record<SessionTranscriptItemType, Parameters<typeof t>[0]> = {
  thinking: "agentRuntime.transcriptThinking",
  tool_call: "agentRuntime.transcriptToolCall",
  tool_result: "agentRuntime.transcriptToolResult",
  text: "agentRuntime.transcriptText",
  error: "agentRuntime.transcriptError",
};
const ITEM_TONE: Record<SessionTranscriptItemType, string> = {
  thinking: "text-status-unknown",
  tool_call: "text-accent",
  tool_result: "text-status-done",
  text: "text-text-muted",
  error: "text-status-blocked",
};

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
  const seen = new Set(current.map(recordKey)),
    unique = fresh.filter((record) => !seen.has(recordKey(record)));
  return prepend ? [...unique, ...current] : [...current, ...unique];
}

function recordKey(record: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(record);
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

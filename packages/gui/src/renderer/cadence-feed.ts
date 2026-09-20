import { useEffect, useRef, useState } from "react";
import { harnessClient } from "./api-client.ts";
import type { ObserveTailRead } from "../api/renderer-dto.ts";
import {
  observePaneCursor,
  observeTailRequest,
  type ObserveTailCursor,
  type ObserveTailMode,
} from "./daemon-observe-model.ts";
import { cadenceEventOf, mergeCadenceEvents, type CadenceFeedEvent } from "./model/cadence.ts";

/**
 * `observe.tail` events 流的聚合 follow 循环。原为研发态势视图私有,总览(新)的
 * 「最近变化」复用同一读取与刷新机制(不另造第二条事件读路):初始沿 history 游标
 * 最多回看 CADENCE_HISTORY_PAGE_BUDGET 页(64/页),此后 live cursor 每
 * CADENCE_FOLLOW_MS 追一次;窗口滚动封顶 CADENCE_EVENT_LIMIT(丢最旧端),
 * `unavailable`(远端 edge 无事件流)显式呈现并慢速重试,不冒充空窗口。
 */

const CADENCE_HISTORY_PAGE_BUDGET = 16,
  CADENCE_FOLLOW_MS = 5_000,
  CADENCE_PENDING_MS = 500,
  CADENCE_ERROR_MS = 1_500,
  CADENCE_UNAVAILABLE_MS = 15_000;

export interface CadenceFeedState {
  readonly status: "loading" | "live" | "unavailable" | "error";
  readonly error: string | null;
  readonly unavailableReason: string | null;
  readonly mode: ObserveTailMode | null;
  readonly events: readonly CadenceFeedEvent[];
  readonly historyComplete: boolean;
  /** 聚合时钟:只在每次窗口变更时前进,保证 derive 的 memo 依赖稳定。 */
  readonly now: string;
}

const CADENCE_FEED_IDLE: CadenceFeedState = {
  status: "loading",
  error: null,
  unavailableReason: null,
  mode: null,
  events: [],
  historyComplete: false,
  now: "1970-01-01T00:00:00.000Z",
};

export function useCadenceFeed(repoId: string): CadenceFeedState {
  const [state, setState] = useState<CadenceFeedState>(CADENCE_FEED_IDLE),
    stateRef = useRef(state),
    commit = (next: CadenceFeedState): void => {
      stateRef.current = next;
      setState(next);
    };

  useEffect(() => {
    let cancelled = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    stateRef.current = CADENCE_FEED_IDLE;
    setState(CADENCE_FEED_IDLE);
    const run = async (): Promise<void> => {
      let events: readonly CadenceFeedEvent[] = [],
        historyCursor: ObserveTailCursor = null,
        liveCursor: ObserveTailCursor = null,
        historyComplete = false,
        pages = 0,
        delay: number;
      while (!cancelled) {
        const walkingHistory: boolean = !historyComplete && pages < CADENCE_HISTORY_PAGE_BUDGET;
        const result:
          | { readonly ok: true; readonly page: ObserveTailRead }
          | { readonly ok: false; readonly message: string } = await harnessClient
          .tailObservability(
            walkingHistory
              ? observeTailRequest(repoId, "events", "history", historyCursor)
              : observeTailRequest(repoId, "events", "follow", liveCursor),
          )
          .then(
            (page): { readonly ok: true; readonly page: ObserveTailRead } => ({ ok: true, page }),
            (error: unknown): { readonly ok: false; readonly message: string } => ({
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        if (cancelled) return;
        if (!result.ok) {
          commit({
            ...stateRef.current,
            status: "error",
            error: result.message,
            now: new Date().toISOString(),
          });
          delay = CADENCE_ERROR_MS;
        } else {
          const page: ObserveTailRead = result.page;
          if (page.status === "unavailable") {
            events = [];
            historyCursor = null;
            liveCursor = null;
            historyComplete = false;
            pages = 0;
            commit({
              ...CADENCE_FEED_IDLE,
              status: "unavailable",
              mode: page.mode,
              unavailableReason: page.unavailable.reason,
              now: new Date().toISOString(),
            });
            delay = CADENCE_UNAVAILABLE_MS;
          } else {
            const merged = mergeCadenceEvents(events, page.items.map(cadenceEventOf));
            events = merged;
            if (page.direction === "history") {
              historyCursor = observePaneCursor(page.historyCursor);
              if (liveCursor === null) liveCursor = observePaneCursor(page.liveCursor);
              historyComplete = page.done;
            } else {
              liveCursor = observePaneCursor(page.liveCursor);
            }
            pages += 1;
            commit({
              status: "live",
              error: null,
              unavailableReason: null,
              mode: page.mode,
              events: merged,
              historyComplete,
              now: new Date().toISOString(),
            });
            delay =
              page.status === "pending"
                ? CADENCE_PENDING_MS
                : historyComplete || page.direction === "follow"
                  ? CADENCE_FOLLOW_MS
                  : 0;
          }
        }
        await new Promise<void>((resolve) => {
          timer = setTimeout(resolve, delay);
        });
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [repoId]);
  return state;
}

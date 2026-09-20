import { useEffect, useMemo, useRef, useState } from "react";
import { harnessClient, type AgendaSuccess } from "../api-client.ts";
import { consumeKnownError } from "../../api/error-consumption.ts";
import type { ObserveTailRead } from "../../api/renderer-dto.ts";
import { t } from "../i18n/index.tsx";
import {
  observePaneCursor,
  observeTailRequest,
  type ObserveTailCursor,
  type ObserveTailMode,
} from "../daemon-observe-model.ts";
import {
  CADENCE_EVENT_LIMIT,
  cadenceEventOf,
  deriveCadenceSnapshot,
  mergeCadenceEvents,
  type CadenceFeedEvent,
  type CadenceInput,
} from "../model/cadence.ts";
import { deriveAttestationLanes } from "../model/attestation-pool.ts";
import { CadenceHud } from "../components/cadence/CadenceHud.tsx";
import { TaskRhythmTrack } from "../components/cadence/TaskRhythmTrack.tsx";
import { FrictionRadar } from "../components/cadence/FrictionRadar.tsx";
import { YieldSummary } from "../components/cadence/YieldSummary.tsx";
import { AttentionBlockers } from "../components/cadence/AttentionBlockers.tsx";
import { FleetPulsePane } from "../components/cadence/FleetPulsePane.tsx";
import { deriveFleetPulse } from "../model/cadence-fleet.ts";
import type { AgentRuntimeSessionDto } from "../../../../daemon/src/agent-runtime-contract.ts";

/**
 * 研发态势(Cadence & Pulse)一级视图:治理域下项目研发心跳的驾驶舱。
 * 数据全部来自既有只读 RPC——`observe.tail`(events 窗口,本视图自带**有界**历史
 * 回看:CADENCE_HISTORY_PAGE_BUDGET 页 × 64 事件,超出显式标注「仅最近窗口」)、
 * `repo.tasks.list` 投影行、`repo.agenda.read` 议程与 `repo.decisions.list` 摘要;
 * GUI 不读文件、不发起任何写操作;跳转复用实体导航与待办签发总池。
 */

const CADENCE_HISTORY_PAGE_BUDGET = 16,
  CADENCE_FOLLOW_MS = 5_000,
  CADENCE_PENDING_MS = 500,
  CADENCE_ERROR_MS = 1_500,
  CADENCE_UNAVAILABLE_MS = 15_000;

interface CadenceFeedState {
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

/**
 * 有界事件窗口:`observe.tail` events 流的聚合面。初始沿 history 游标最多回看
 * CADENCE_HISTORY_PAGE_BUDGET 页(64/页),此后 live cursor 每 CADENCE_FOLLOW_MS 追一次;
 * 窗口滚动封顶 CADENCE_EVENT_LIMIT(丢最旧端),`unavailable`(远端 edge 无事件流)
 * 显式呈现并慢速重试,不冒充空窗口。
 */
function useCadenceFeed(repoId: string): CadenceFeedState {
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
        try {
          const walkingHistory = !historyComplete && pages < CADENCE_HISTORY_PAGE_BUDGET,
            page: ObserveTailRead = await harnessClient.tailObservability(
              walkingHistory
                ? observeTailRequest(repoId, "events", "history", historyCursor)
                : observeTailRequest(repoId, "events", "follow", liveCursor),
            );
          if (cancelled) return;
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
        } catch (error) {
          // 失败投影为可读横幅并按 CADENCE_ERROR_MS 重试;不吞错继续跑。
          consumeKnownError(error);
          if (cancelled) return;
          commit({
            ...stateRef.current,
            status: "error",
            error: error instanceof Error ? error.message : String(error),
            now: new Date().toISOString(),
          });
          delay = CADENCE_ERROR_MS;
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

const MODE_LABEL: Record<ObserveTailMode, () => string> = {
  local: () => t("views.daemonObserve.modeLocal"),
  "remote-proxy": () => t("views.daemonObserve.modeProxy"),
  "remote-center": () => t("views.daemonObserve.modeCenter"),
  "remote-edge": () => t("views.daemonObserve.modeEdge"),
};

export function CadenceView({
  repoId,
  projectName,
  tasks,
  agenda,
  decisions,
  onNavigateEntity,
  onOpenPool,
  activeSessions = [],
}: {
  readonly repoId: string;
  readonly projectName: string;
  readonly tasks: CadenceInput["tasks"];
  readonly agenda: AgendaSuccess | undefined;
  readonly decisions: CadenceInput["decisions"];
  readonly onNavigateEntity: (ref: string) => void;
  readonly onOpenPool: () => void;
  readonly activeSessions?: readonly AgentRuntimeSessionDto[];
}) {
  const [tab, setTab] = useState<"tasks" | "fleet">("tasks"),
    feed = useCadenceFeed(repoId),
    // 议程未读完(pending)时 awaiting 为 null:HUD 与堵点卡片如实显示读取中,不冒充。
    awaiting = useMemo(
      () => (agenda !== undefined && agenda.status === "ready" ? agenda.awaitingDecision : null),
      [agenda],
    ),
    awaitingDetail = useMemo(() => {
      if (awaiting === null) return null;
      return {
        decisions: awaiting.filter((row) => row.kind === "decision").length,
        executions: awaiting.filter((row) => row.kind === "execution").length,
      };
    }, [awaiting]),
    lanes = useMemo(() => deriveAttestationLanes(tasks), [tasks]),
    snapshot = useMemo(
      () =>
        deriveCadenceSnapshot({
          events: feed.events,
          tasks,
          decisions,
          awaitingHuman: awaiting === null ? null : awaiting.length,
          now: feed.now,
        }),
      [feed.events, feed.now, tasks, decisions, awaiting],
    ),
    fleet = useMemo(
      () => deriveFleetPulse({ sessions: activeSessions, tasks, events: feed.events }),
      [activeSessions, tasks, feed.events],
    ),
    openTask = (taskId: string): void => {
      onNavigateEntity(`task/${taskId}`);
    };
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex flex-wrap items-baseline gap-2 border-b border-border bg-surface/40 px-5 py-3">
        <h1 className="ui-title font-semibold">{t("views.cadence.title")}</h1>
        <span className="truncate font-mono ui-meta text-text-faint">{projectName}</span>
        <span
          data-testid="cadence-stream"
          className="ml-auto flex flex-wrap items-baseline gap-2 font-mono ui-micro text-text-faint"
        >
          {feed.mode === null ? null : <span>{MODE_LABEL[feed.mode]()}</span>}
          <span>{t("views.cadence.streamScanned", { count: feed.events.length })}</span>
          <span>{t(feed.historyComplete ? "views.cadence.windowComplete" : "views.cadence.windowPartial")}</span>
        </span>
      </header>
      {feed.status === "unavailable" ? (
        <p
          data-testid="cadence-unavailable"
          className="border-b border-border bg-status-blocked/5 px-4 py-2 ui-meta text-status-blocked"
        >
          {t("views.cadence.unavailableTitle")} {unavailableText(feed.unavailableReason)}
        </p>
      ) : null}
      {feed.status === "error" ? (
        <p
          data-testid="cadence-error"
          className="border-b border-border bg-status-blocked/5 px-4 py-2 ui-meta text-status-blocked"
        >
          {t("views.cadence.errorTitle")} {feed.error}
        </p>
      ) : null}
      <div
        role="tablist"
        aria-label={t("views.cadence.tabsLabel")}
        className="flex gap-1 border-b border-border px-4 pt-2"
      >
        {(["tasks", "fleet"] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`rounded-t px-3 py-2 ui-meta ${tab === id ? "bg-surface-raised text-accent" : "text-text-muted hover:text-text"}`}
          >
            {t(`views.cadence.tab.${id}`)}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
        {tab === "fleet" ? (
          <FleetPulsePane snapshot={fleet} onNavigateEntity={onNavigateEntity} />
        ) : (
          <>
            <CadenceHud hud={snapshot.hud} awaitingDetail={awaitingDetail} />
            <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[1.5fr_1fr]">
              <div className="flex min-h-[320px] flex-col lg:min-h-0">
                <TaskRhythmTrack entries={snapshot.rhythm} onNavigateEntity={onNavigateEntity} />
              </div>
              <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
                <AttentionBlockers
                  awaiting={awaiting}
                  lanes={lanes}
                  onNavigateEntity={onNavigateEntity}
                  onOpenPool={onOpenPool}
                />
                <FrictionRadar friction={snapshot.friction} onOpenTask={openTask} />
                <YieldSummary snapshot={snapshot.yield} onNavigateEntity={onNavigateEntity} />
              </div>
            </div>
          </>
        )}
        <p className="shrink-0 ui-micro text-text-faint">
          {t("views.cadence.windowNote", { limit: CADENCE_EVENT_LIMIT })}
        </p>
      </div>
    </div>
  );
}

function unavailableText(reason: string | null): string {
  if (reason === "center-request-log-not-wired") return t("views.daemonObserve.unavailableCenterLog");
  return t("views.daemonObserve.unavailableEdge");
}

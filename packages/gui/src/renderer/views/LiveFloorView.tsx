import { useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { AgentRuntimeSessionDto } from "@harness-anything/daemon/protocol";
import type { TaskDispatchProjectionRow, TaskDispatchesRead } from "../../api/renderer-dto.ts";
import { harnessClient } from "../api-client.ts";
import { agentRuntimeClient, runtimeQueryKeys } from "../agent-runtime-client.ts";
import { t, type MessageKey } from "../i18n/index.tsx";
import { formatDuration, formatTime } from "../model/time.ts";
import type { TaskRow } from "../model/types.ts";
import type { WorkIndex } from "../model/work-collections.ts";
import { QUERY_PACING_MS } from "../query-pacing.ts";
import { useAgendaQuery } from "../agenda-data.ts";
import { taskDocumentQuery } from "../task-data.ts";
import { type AwaitsPanelSubject } from "../awaits-answer.ts";
import { AwaitsAnswerPanel } from "../components/AwaitsAnswerPanel.tsx";
import { SessionTranscript } from "../components/sessions/SessionTranscript.tsx";
import { ApprovalCard, type ApprovalRisk } from "../components/agent-ui/ApprovalCard.tsx";
import { DenseRow, RowTime } from "../components/primitives/DenseRow.tsx";
import { Drawer } from "../components/primitives/Drawer.tsx";
import { Empty } from "../components/primitives/Empty.tsx";
import { PageHeader } from "../components/primitives/PageHeader.tsx";
import { StatusTag, type StatusTone } from "../components/primitives/StatusTag.tsx";
import {
  liveFloorAction,
  liveFloorAskLanes,
  liveFloorDispatchChannel,
  liveFloorEndedRows,
  liveFloorPipelineGroups,
  liveFloorReportDocPath,
  liveFloorRows,
  liveFloorWorkGroups,
  readableModelName,
  type LiveFloorAction,
  type LiveFloorAskKind,
  type LiveFloorAskRow,
  type LiveFloorChannel,
  type LiveFloorEndedConclusion,
  type LiveFloorPipelineKey,
} from "./live-floor-model.ts";
import {
  readLiveFloorPreferences,
  writeLiveFloorPreferences,
  type LiveFloorPreferenceStorage,
} from "../live-floor-preferences.ts";

const EMPTY_SESSIONS: readonly AgentRuntimeSessionDto[] = [];
/** The renderer's localStorage behind a seam so the model stays testable without a DOM. */
const PREFERENCE_STORAGE: LiveFloorPreferenceStorage | null =
  typeof window === "undefined" ? null : window.localStorage;
/** 「刚结束」的时间窗与 daemon 完成列同口径:派工查询按它选候选任务。 */
const ENDED_CANDIDATE_WINDOW_MS = 24 * 60 * 60_000;

export function LiveFloorView({
  repoId,
  tasks,
  taskTitles,
  works,
  onOpenTask,
  onNavigateEntity,
}: {
  readonly repoId: string;
  readonly tasks: readonly TaskRow[];
  readonly taskTitles: ReadonlyMap<string, string>;
  readonly works: WorkIndex;
  readonly onOpenTask: (taskId: string) => void;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const [scope, setScope] = useState(
      () => readLiveFloorPreferences(PREFERENCE_STORAGE ?? { getItem: () => null }).scope,
    ),
    [drawerTaskId, setDrawerTaskId] = useState<string | null>(null),
    [panel, setPanel] = useState<AwaitsPanelSubject | null>(null);
  const chooseScope = (next: "project" | "all") => {
    setScope(next);
    if (PREFERENCE_STORAGE !== null) writeLiveFloorPreferences(PREFERENCE_STORAGE, { scope: next });
  };

  const runtime = useQuery({
      queryKey: runtimeQueryKeys.overviewAll(repoId),
      queryFn: () => agentRuntimeClient.overview(repoId),
      staleTime: 4_000,
      refetchInterval: QUERY_PACING_MS.tokenUsage,
    }),
    sessions = runtime.data?.sessions ?? EMPTY_SESSIONS,
    liveTaskIds = useMemo(
      () => [...new Set(sessions.flatMap((session) => session.associations.map(({ taskId }) => taskId)))].sort(),
      [sessions],
    ),
    // 「刚结束」的候选任务:24h 内有更新的任务(派工结算会把档案写进任务包,updatedAt 随之推进)。
    recentTaskIds = useMemo(() => {
      const cutoff = Date.now() - ENDED_CANDIDATE_WINDOW_MS;
      return tasks
        .filter((task) => Date.parse(task.lastKnownAt) >= cutoff)
        .map(({ taskId }) => taskId)
        .sort();
    }, [tasks]),
    dispatchTaskIds = useMemo(
      () => [...new Set([...liveTaskIds, ...recentTaskIds])].sort(),
      [liveTaskIds, recentTaskIds],
    ),
    dispatches = useQuery({
      queryKey: [...runtimeQueryKeys.dispatchesAll(repoId), "live-floor", dispatchTaskIds.join("\0")],
      queryFn: async () => {
        if (dispatchTaskIds.length === 0) return [] as readonly TaskDispatchProjectionRow[];
        const read = (await harnessClient.getTaskDispatches({
          repoId,
          taskIds: dispatchTaskIds,
          limit: 500,
        })) as TaskDispatchesRead;
        return read.dispatches as readonly TaskDispatchProjectionRow[];
      },
      enabled: runtime.data !== undefined,
      staleTime: 4_000,
      refetchInterval: QUERY_PACING_MS.tokenUsage,
    }),
    agenda = useAgendaQuery(repoId),
    // decision ask 的依据(提案原文问题)要先于 asks 组装就绪:候选直接取 agenda 的两个
    // decision 池,不经过 asks,否则声明顺序成环。
    decisionAsks = useMemo(
      () =>
        [
          ...new Set(
            [...(agenda.data?.awaitingDecision ?? []), ...(agenda.data?.awaitingDecisionReview ?? [])].map(
              ({ decisionId }) => decisionId,
            ),
          ),
        ].sort(),
      [agenda.data],
    ),
    decisionReads = useQueries({
      queries: decisionAsks.map((decisionId) => ({
        queryKey: ["live-floor-decision", repoId, decisionId],
        queryFn: () => harnessClient.showDecision({ repoId, decisionId, includeBody: false }),
        staleTime: 30_000,
      })),
    }),
    decisionQuestions = useMemo(() => {
      const questions = new Map<string, string>();
      decisionAsks.forEach((decisionId, index) => {
        const question = decisionReads[index]?.data?.decision.question;
        if (question) questions.set(decisionId, question);
      });
      return questions;
    }, [decisionAsks, decisionReads]),
    liveRows = useMemo(
      () => liveFloorRows({ sessions, dispatches: dispatches.data ?? [], taskTitles, works }),
      [dispatches.data, sessions, taskTitles, works],
    ),
    groups = useMemo(() => liveFloorWorkGroups(liveRows), [liveRows]),
    endedRows = useMemo(
      () => liveFloorEndedRows({ dispatches: dispatches.data ?? [], taskTitles, tasks }),
      [dispatches.data, taskTitles, tasks],
    ),
    pipeline = useMemo(() => liveFloorPipelineGroups(tasks, works), [tasks, works]),
    asks = useMemo(
      () =>
        liveFloorAskLanes({
          agenda: agenda.data ?? null,
          tasks,
          decisionQuestions,
          labels: { gates: t("views.liveFloor.evidenceGates"), ci: t("views.liveFloor.evidenceCi") },
        }),
      [agenda.data, tasks, decisionQuestions],
    ),
    actionReads = useQueries({
      queries: liveRows.flatMap((row) =>
        row.dispatch === null
          ? []
          : [
              {
                queryKey: ["live-floor-action", repoId, row.dispatch.dispatchId],
                queryFn: () =>
                  harnessClient.tailObservability({
                    repoId,
                    kind: "dispatch",
                    dispatchId: row.dispatch!.dispatchId,
                    direction: "history",
                  }),
                staleTime: 4_000,
                refetchInterval: QUERY_PACING_MS.tokenUsage,
              },
            ],
      ),
    });
  const actionByDispatch = new Map<string, LiveFloorAction>();
  let actionIndex = 0;
  for (const row of liveRows) {
    if (row.dispatch === null) continue;
    const read = actionReads[actionIndex++]?.data;
    if (read && read.status !== "gap" && read.status !== "unavailable") {
      const action = liveFloorAction(read.items.filter(isRecord));
      if (action) actionByDispatch.set(row.dispatch.dispatchId, action);
    }
  }

  const loading = runtime.isPending || (runtime.data !== undefined && dispatches.isPending),
    error = runtime.error ?? dispatches.error,
    drawerTask = drawerTaskId === null ? null : (tasks.find((task) => task.taskId === drawerTaskId) ?? null);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="live-floor-page">
      <PageHeader
        title={t("views.liveFloor.title")}
        note={t("views.liveFloor.note")}
        meta={runtime.data === undefined ? "—" : t("views.liveFloor.liveCount", { count: String(liveRows.length) })}
        actions={
          <div className="flex items-center gap-1" data-testid="live-floor-scope">
            {(["project", "all"] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={
                  "rounded border px-2.5 py-1 text-xs " +
                  (scope === option
                    ? "border-accent bg-accent/10 font-medium text-accent"
                    : "border-border text-text-muted hover:text-text")
                }
                aria-pressed={scope === option}
                data-testid={`live-floor-scope-${option}`}
                onClick={() => chooseScope(option)}
              >
                {t(option === "project" ? "views.liveFloor.scopeProject" : "views.liveFloor.scopeAll")}
              </button>
            ))}
          </div>
        }
        testId="live-floor-header"
      />
      <div className="content-viewport min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {scope === "all" ? (
          <Empty>{t("views.liveFloor.scopeAllPending")}</Empty>
        ) : error ? (
          <p role="alert" className="py-3 ui-meta text-status-blocked">
            {t("views.liveFloor.readError", { message: error instanceof Error ? error.message : String(error) })}
          </p>
        ) : loading ? (
          <p className="py-3 ui-meta text-text-muted">{t("views.liveFloor.loading")}</p>
        ) : (
          <>
            {/* 「要我」放首屏第一屏:只有业主能拍板的事压过「在干活」。 */}
            <section aria-label={t("views.liveFloor.asksTitle")} data-testid="live-floor-asks">
              <SectionHead label={t("views.liveFloor.asksTitle")} count={asks.length} />
              {asks.length === 0 ? (
                <Empty>{t("views.liveFloor.asksEmpty")}</Empty>
              ) : (
                <div className="flex flex-col gap-2">
                  {asks.map((ask) =>
                    ask.kind === "ask" && ask.ask !== null ? (
                      <AskApprovalCard
                        key={ask.key}
                        ask={ask}
                        onAnswer={() => setPanel({ mode: "answer", row: ask.ask! })}
                        onOpenSource={setDrawerTaskId}
                      />
                    ) : (
                      <AskDenseRow
                        key={ask.key}
                        ask={ask}
                        onOpenTask={setDrawerTaskId}
                        onNavigateEntity={onNavigateEntity}
                      />
                    ),
                  )}
                </div>
              )}
            </section>
            <section aria-label={t("views.liveFloor.sectionTitle")} data-testid="live-floor-running">
              <SectionHead label={t("views.liveFloor.sectionTitle")} count={liveRows.length} />
              {liveRows.length === 0 ? (
                <Empty>{t("views.liveFloor.empty")}</Empty>
              ) : (
                <div className="divide-y divide-border">
                  {groups.map((group) => (
                    <details key={group.key} open className="group/live-work">
                      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 py-2 text-sm font-medium text-text">
                        <span
                          className="text-text-faint transition-transform group-open/live-work:rotate-90"
                          aria-hidden="true"
                        >
                          ›
                        </span>
                        <span className="min-w-0 flex-1 truncate">
                          {group.title || t("views.liveFloor.unassignedWork")}
                        </span>
                        <span className="font-mono ui-meta text-text-faint">{group.rows.length}</span>
                      </summary>
                      <div className="pb-2">
                        {group.rows.map((row) => (
                          <LiveFloorSessionRow
                            key={row.session.runtimeSessionId}
                            row={row}
                            action={row.dispatch ? (actionByDispatch.get(row.dispatch.dispatchId) ?? null) : null}
                            onOpenTask={setDrawerTaskId}
                          />
                        ))}
                      </div>
                    </details>
                  ))}
                </div>
              )}
            </section>
            <section aria-label={t("views.liveFloor.endedTitle")} data-testid="live-floor-ended">
              <SectionHead
                label={t("views.liveFloor.endedTitle")}
                count={endedRows.length}
                note={t("views.liveFloor.endedWindowNote")}
              />
              {endedRows.length === 0 ? (
                <Empty>{t("views.liveFloor.endedEmpty")}</Empty>
              ) : (
                <div className="divide-y divide-border/70">
                  {endedRows.map((row) => (
                    <LiveFloorEndedRowView
                      key={row.dispatch.dispatchId}
                      repoId={repoId}
                      row={row}
                      tasks={tasks}
                      onOpenTask={setDrawerTaskId}
                    />
                  ))}
                </div>
              )}
            </section>
            <section aria-label={t("views.liveFloor.pipelineTitle")} data-testid="live-floor-pipeline">
              <SectionHead
                label={t("views.liveFloor.pipelineTitle")}
                count={pipeline.reduce((sum, group) => sum + group.tasks.length, 0)}
              />
              {pipeline.length === 0 ? (
                <Empty>{t("views.liveFloor.pipelineEmpty")}</Empty>
              ) : (
                <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
                  {pipeline.map((group) => (
                    <div
                      key={group.key}
                      className="min-w-0 rounded-lg border border-border bg-panel-soft/40 p-2"
                      data-testid={`live-floor-stage-${group.key}`}
                    >
                      <div className="flex items-baseline gap-2 pb-1.5">
                        <span className="min-w-0 truncate text-sm font-medium text-text">
                          {t(PIPELINE_STAGE_LABEL[group.key])}
                        </span>
                        <span className="ml-auto font-mono ui-meta text-text-faint">{group.tasks.length}</span>
                      </div>
                      <div className="flex flex-col">
                        {group.tasks.map((task) => (
                          <button
                            key={task.taskId}
                            type="button"
                            className="min-w-0 truncate py-1 text-left text-sm text-text-muted hover:text-accent"
                            title={task.title}
                            onClick={() => setDrawerTaskId(task.taskId)}
                          >
                            {group.key === "rework" ? (
                              <span className="mr-1.5 rounded bg-danger/10 px-1 py-0.5 text-xs text-danger">
                                {t("views.liveFloor.stageReturnedMark")}
                              </span>
                            ) : null}
                            {task.title}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>
      <Drawer open={drawerTaskId !== null} onClose={() => setDrawerTaskId(null)} ariaLabel={drawerTask?.title}>
        {drawerTaskId !== null ? (
          <LiveFloorTaskTimeline repoId={repoId} taskId={drawerTaskId} task={drawerTask} onOpenTask={onOpenTask} />
        ) : null}
      </Drawer>
      {panel ? (
        <AwaitsAnswerPanel
          repoId={repoId}
          subject={panel}
          onClose={() => setPanel(null)}
          onNavigateEntity={(ref) => {
            setPanel(null);
            onNavigateEntity(ref);
          }}
        />
      ) : null}
    </div>
  );
}

function SectionHead({
  label,
  count,
  note,
}: {
  readonly label: string;
  readonly count: number;
  readonly note?: string;
}) {
  return (
    <div className="flex items-baseline gap-2 border-b border-border py-2">
      <h2 className="text-base font-semibold text-text">{label}</h2>
      <span className="font-mono ui-meta text-text-faint">{count}</span>
      {note ? <span className="ml-auto ui-meta text-text-faint">{note}</span> : null}
    </div>
  );
}

const PIPELINE_STAGE_LABEL: Readonly<Record<LiveFloorPipelineKey, MessageKey>> = {
  queued: "views.liveFloor.stageQueued",
  implementing: "views.liveFloor.stageImplementing",
  rework: "views.liveFloor.stageRework",
  delivered: "views.liveFloor.stageDelivered",
  reviewing: "views.liveFloor.stageReviewing",
  awaiting_owner: "views.liveFloor.stageAwaitingOwner",
  merge_ready: "views.liveFloor.stageMergeReady",
  done: "views.liveFloor.stageDone",
  waiting_upstream: "views.liveFloor.stageWaitingUpstream",
  other: "views.liveFloor.stageOther",
};

const CHANNEL_LABEL: Readonly<Record<LiveFloorChannel, MessageKey>> = {
  implementation: "views.liveFloor.channelImplementation",
  rework: "views.liveFloor.channelRework",
  review_task: "views.liveFloor.channelReviewTask",
  review_decision: "views.liveFloor.channelReviewDecision",
  unknown: "views.liveFloor.channelUnknown",
};

const ACTION_VERB_LABEL: Readonly<Record<string, MessageKey>> = {
  run_command: "views.liveFloor.actionRunCommand",
  run_test: "views.liveFloor.actionRunTest",
  edit_file: "views.liveFloor.actionEditFile",
  read_file: "views.liveFloor.actionReadFile",
  search_code: "views.liveFloor.actionSearchCode",
  browse: "views.liveFloor.actionBrowse",
  plan: "views.liveFloor.actionPlan",
  git: "views.liveFloor.actionGit",
  message: "views.liveFloor.actionMessage",
  tool: "views.liveFloor.actionTool",
};

const ENDED_LABEL: Readonly<Record<LiveFloorEndedConclusion, MessageKey>> = {
  delivered: "views.liveFloor.endedDelivered",
  review_done: "views.liveFloor.endedReviewDone",
  review_rejected: "views.liveFloor.endedReviewRejected",
  interrupted: "views.liveFloor.endedInterrupted",
  empty_report: "views.liveFloor.endedEmptyReport",
  failed: "views.liveFloor.endedFailed",
  cancelled: "views.liveFloor.endedCancelled",
  unknown: "views.liveFloor.endedUnknown",
};

const ENDED_TONE: Readonly<Record<LiveFloorEndedConclusion, StatusTone>> = {
  delivered: "done",
  review_done: "done",
  review_rejected: "bad",
  interrupted: "bad",
  empty_report: "bad",
  failed: "bad",
  cancelled: "cancel",
  unknown: "neutral",
};

function LiveFloorSessionRow({
  row,
  action,
  onOpenTask,
}: {
  readonly row: ReturnType<typeof liveFloorRows>[number];
  readonly action: LiveFloorAction | null;
  readonly onOpenTask: (taskId: string) => void;
}) {
  // 缺信号要说明缺哪项,不折叠成「状态未知」:无派工行与旧 daemon 缺投影是两回事。
  const [statusKey, tone]: [MessageKey, StatusTone] =
      row.activityStatus === "thinking"
        ? ["views.liveFloor.statusThinking", "active"]
        : row.activityStatus === "tool"
          ? ["views.liveFloor.statusTool", "active"]
          : row.activityStatus === "waiting"
            ? ["views.liveFloor.statusWaiting", "wait"]
            : row.activityStatus === "silent"
              ? ["views.liveFloor.statusSilent", "bad"]
              : row.activityStatus === "unknown"
                ? ["views.liveFloor.statusUnknown", "neutral"]
                : row.dispatch === null
                  ? ["views.liveFloor.statusNoDispatch", "neutral"]
                  : ["views.liveFloor.statusNoProjection", "neutral"],
    model = readableModelName(row.model),
    duration = row.startedAt ? formatDuration(Date.now() - Date.parse(row.startedAt)) : null,
    statusLabel =
      row.activityStatus === "silent"
        ? t(statusKey, { minutes: String(Math.max(1, row.activityIdleMinutes ?? 0)) })
        : t(statusKey),
    actionText =
      action === null ? null : [t(ACTION_VERB_LABEL[action.verb]), action.subject].filter(Boolean).join(" · ") || null;
  return (
    <article
      className="grid min-w-0 grid-cols-[minmax(12rem,1.2fr)_minmax(10rem,1fr)_minmax(9rem,.8fr)_minmax(8rem,.65fr)] items-center gap-x-4 gap-y-1 border-t border-border/70 py-2.5 first:border-0 max-[980px]:grid-cols-[minmax(0,1fr)_auto]"
      data-testid="live-floor-session-row"
    >
      {row.taskId && row.taskTitle ? (
        <button
          type="button"
          className="min-w-0 truncate text-left text-sm font-medium text-text hover:text-accent"
          title={row.taskTitle}
          onClick={() => onOpenTask(row.taskId!)}
        >
          {row.taskTitle}
        </button>
      ) : (
        <span className="min-w-0 truncate text-sm font-medium text-text">
          {row.taskTitle || t("views.liveFloor.noTask")}
        </span>
      )}
      <span
        className="min-w-0 truncate text-sm text-text-muted"
        title={action?.raw ?? undefined}
        data-testid="live-floor-session-action"
      >
        {actionText ?? t(CHANNEL_FALLBACK_ACTION[row.channel])}
      </span>
      <span className="flex min-w-0 items-center gap-2 text-xs text-text-muted">
        <span className="truncate">{t(CHANNEL_LABEL[row.channel])}</span>
        <span aria-hidden="true">·</span>
        <span className="truncate" title={row.model ?? undefined}>
          {model ?? t("views.liveFloor.modelUnknown")}
        </span>
      </span>
      <span className="flex items-center justify-end gap-2">
        <StatusTag tone={tone} label={statusLabel} />
        <span
          className="font-mono ui-meta tabular-nums text-text-faint"
          title={row.startedAt ? (formatTime(row.startedAt, { style: "date-time-seconds" }) ?? undefined) : undefined}
        >
          {duration ?? "—"}
        </span>
      </span>
    </article>
  );
}

/** 没有转录记录时的兜底:通道本身就是「正在做什么」的粗粒度答案。 */
const CHANNEL_FALLBACK_ACTION: Readonly<Record<LiveFloorChannel, MessageKey>> = {
  implementation: "views.liveFloor.doingImplementation",
  rework: "views.liveFloor.doingRework",
  review_task: "views.liveFloor.doingReviewTask",
  review_decision: "views.liveFloor.doingReviewDecision",
  unknown: "views.liveFloor.noRecentAction",
};

function LiveFloorEndedRowView({
  repoId,
  row,
  tasks,
  onOpenTask,
}: {
  readonly repoId: string;
  readonly row: ReturnType<typeof liveFloorEndedRows>[number];
  readonly tasks: readonly TaskRow[];
  readonly onOpenTask: (taskId: string) => void;
}) {
  const [open, setOpen] = useState(false),
    task = row.taskId === null ? null : (tasks.find((entry) => entry.taskId === row.taskId) ?? null);
  return (
    <details
      className="group/live-ended"
      data-testid="live-floor-ended-row"
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary className="grid min-w-0 cursor-pointer list-none grid-cols-[minmax(12rem,1.3fr)_minmax(9rem,.9fr)_auto_auto_auto] items-center gap-x-4 py-2 max-[980px]:grid-cols-[minmax(0,1fr)_auto]">
        {row.taskId ? (
          <span
            className="min-w-0 truncate text-left text-sm font-medium text-text"
            role="button"
            tabIndex={0}
            title={row.taskTitle || row.taskId}
            onClick={(event) => {
              event.preventDefault();
              onOpenTask(row.taskId!);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              onOpenTask(row.taskId!);
            }}
          >
            {row.taskTitle || row.taskId}
          </span>
        ) : (
          <span className="min-w-0 truncate text-sm text-text">{t("views.liveFloor.noTask")}</span>
        )}
        <span className="truncate text-xs text-text-muted">{t(CHANNEL_LABEL[row.channel])}</span>
        <StatusTag tone={ENDED_TONE[row.conclusion]} label={t(ENDED_LABEL[row.conclusion])} />
        <span className="flex items-center justify-end text-xs text-text-faint">
          <RowTime at={row.endedAt ?? row.dispatch.startedAt} />
        </span>
        {row.reportPath ? (
          <span className="ui-meta text-text-faint group-open/live-ended:hidden">
            {t("views.liveFloor.endedReportToggle")}
          </span>
        ) : (
          <span />
        )}
      </summary>
      {open && row.reportPath ? (
        <LiveFloorReport
          repoId={repoId}
          taskId={row.taskId ?? ""}
          reportPath={row.reportPath}
          packagePath={task?.packagePath ?? null}
        />
      ) : null}
    </details>
  );
}

const ASK_LABEL: Readonly<Record<Exclude<LiveFloorAskKind, "ask">, MessageKey>> = {
  gate: "views.liveFloor.askGate",
  gate_override: "views.liveFloor.askGateOverride",
  consent: "views.liveFloor.askConsent",
  decision: "views.liveFloor.askDecision",
  decision_review: "views.liveFloor.askDecisionReview",
  rework: "views.liveFloor.askRework",
  adjudicate: "views.liveFloor.askAdjudicate",
  pinned: "views.liveFloor.askPinned",
};

const ASK_TONE: Readonly<Record<LiveFloorAskKind, StatusTone>> = {
  ask: "agent-question",
  gate: "wait",
  gate_override: "bad",
  consent: "wait",
  decision: "wait",
  decision_review: "wait",
  rework: "bad",
  adjudicate: "wait",
  pinned: "neutral",
};

const ASK_VERB: Readonly<Record<string, MessageKey>> = {
  question: "views.myAsks.askQuestion",
  acceptance: "views.myAsks.askAcceptance",
  consent: "views.myAsks.askConsent",
  reopen: "views.myAsks.askReopen",
};

function AskApprovalCard({
  ask,
  onAnswer,
  onOpenSource,
}: {
  readonly ask: LiveFloorAskRow;
  readonly onAnswer: () => void;
  readonly onOpenSource: (taskId: string) => void;
}) {
  const row = ask.ask!,
    risk: ApprovalRisk = row.askKind === "consent" ? "protected" : row.askKind === "acceptance" ? "high" : "medium";
  return (
    <div className="rounded-xl border border-agent-question-border bg-agent-question-surface/40 p-2.5">
      <ApprovalCard
        title={ask.title}
        summary={t(ASK_VERB[row.askKind] ?? "views.myAsks.askQuestion")}
        risk={risk}
        previewLines={[row.question]}
        previewKind="changes"
        testId={`live-floor-ask-${row.relationId}`}
        extraActions={
          ask.taskId !== null ? (
            <button
              type="button"
              className="px-2 py-1 text-xs text-text-muted hover:text-accent"
              onClick={() => onOpenSource(ask.taskId!)}
            >
              {t("views.liveFloor.askOpenSource")}
            </button>
          ) : undefined
        }
        approveLabel={t("views.myAsks.actionAnswer")}
        approveTestId={`live-floor-answer-${row.relationId}`}
        onDecide={onAnswer}
      />
    </div>
  );
}

function AskDenseRow({
  ask,
  onOpenTask,
  onNavigateEntity,
}: {
  readonly ask: LiveFloorAskRow;
  readonly onOpenTask: (taskId: string) => void;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const open = () => {
    if (ask.taskId !== null) onOpenTask(ask.taskId);
    else if (ask.decisionId !== null) onNavigateEntity(`decision/${ask.decisionId}`);
  };
  return (
    <DenseRow
      tag={ask.kind === "ask" ? undefined : <StatusTag tone={ASK_TONE[ask.kind]} label={t(ASK_LABEL[ask.kind])} />}
      title={ask.title}
      reason={ask.detail ?? undefined}
      time={ask.at === null ? undefined : <RowTime at={ask.at} />}
      onClick={open}
    />
  );
}

/** 任务弹层:该任务全部派工按时间排开,每个会话可展开工具调用过程与报告原文。 */
function LiveFloorTaskTimeline({
  repoId,
  taskId,
  task,
  onOpenTask,
}: {
  readonly repoId: string;
  readonly taskId: string;
  readonly task: TaskRow | null;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const dispatches = useQuery({
      queryKey: ["live-floor-task-dispatches", repoId, taskId],
      queryFn: async () => {
        const read = (await harnessClient.getTaskDispatches({
          repoId,
          taskIds: [taskId],
          limit: 500,
        })) as TaskDispatchesRead;
        return read.dispatches as readonly TaskDispatchProjectionRow[];
      },
      staleTime: 4_000,
    }),
    rows = useMemo(
      () => [...(dispatches.data ?? [])].sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
      [dispatches.data],
    );
  return (
    <div className="flex flex-col gap-3" data-testid="live-floor-task-drawer">
      {task ? (
        <div className="flex items-baseline gap-2">
          <h2 className="ui-title text-text">{task.title}</h2>
          <button
            type="button"
            className="ml-auto px-2 py-1 text-xs text-text-muted hover:text-accent"
            onClick={() => onOpenTask(task.taskId)}
          >
            {t("views.liveFloor.askOpenSource")}
          </button>
        </div>
      ) : null}
      <h3 className="font-mono ui-meta uppercase tracking-wide text-text-faint">
        {t("views.liveFloor.drawerSessions")}
      </h3>
      {dispatches.isPending ? (
        <p className="ui-meta text-text-muted">{t("views.liveFloor.loading")}</p>
      ) : rows.length === 0 ? (
        <p className="ui-meta text-text-faint">{t("views.liveFloor.drawerNoDispatches")}</p>
      ) : (
        rows.map((dispatch) => (
          <LiveFloorDispatchCard
            key={dispatch.dispatchId}
            repoId={repoId}
            taskId={taskId}
            dispatch={dispatch}
            packagePath={task?.packagePath ?? null}
          />
        ))
      )}
    </div>
  );
}

function LiveFloorDispatchCard({
  repoId,
  taskId,
  dispatch,
  packagePath,
}: {
  readonly repoId: string;
  readonly taskId: string;
  readonly dispatch: TaskDispatchProjectionRow;
  readonly packagePath: string | null;
}) {
  const [open, setOpen] = useState(false),
    channel = liveFloorDispatchChannel(dispatch),
    model = readableModelName(dispatch.provider.model),
    running = dispatch.status === "running",
    duration =
      dispatch.endedAt !== null
        ? formatDuration(Date.parse(dispatch.endedAt) - Date.parse(dispatch.startedAt))
        : formatDuration(Date.now() - Date.parse(dispatch.startedAt));
  return (
    <details
      className="rounded-lg border border-border"
      data-testid="live-floor-dispatch"
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 text-sm">
        <StatusTag
          tone={
            running
              ? "active"
              : dispatch.outcome === "succeeded"
                ? "done"
                : dispatch.outcome === "failed"
                  ? "bad"
                  : "neutral"
          }
          label={t(CHANNEL_LABEL[channel])}
        />
        <span className="min-w-0 truncate text-text-muted" title={dispatch.provider.model ?? undefined}>
          {model ?? t("views.liveFloor.modelUnknown")}
        </span>
        <span
          className="ml-auto font-mono ui-meta text-text-faint"
          title={formatTime(dispatch.startedAt, { style: "date-time-seconds" }) ?? undefined}
        >
          {duration}
        </span>
      </summary>
      <div className="flex flex-col gap-2 border-t border-border px-2.5 py-2">
        {open ? (
          <SessionTranscript repoId={repoId} dispatchId={dispatch.dispatchId} live={running} onSettled={() => {}} />
        ) : null}
        {open && dispatch.reportPath ? (
          <LiveFloorReport repoId={repoId} taskId={taskId} reportPath={dispatch.reportPath} packagePath={packagePath} />
        ) : null}
      </div>
    </details>
  );
}

/** 报告原文:派工行冻结的 reportPath → 任务包文档读面;懒加载在展开时才发生。 */
function LiveFloorReport({
  repoId,
  taskId,
  reportPath,
  packagePath,
}: {
  readonly repoId: string;
  readonly taskId: string;
  readonly reportPath: string;
  readonly packagePath: string | null;
}) {
  const docPath = liveFloorReportDocPath(reportPath, packagePath),
    doc = useQuery({
      ...taskDocumentQuery(repoId, taskId, docPath ?? ""),
      enabled: docPath !== null,
    });
  if (docPath === null) return null;
  return (
    <section className="rounded border border-border" data-testid="live-floor-report">
      <h4 className="border-b border-border px-2.5 py-1.5 font-mono ui-meta uppercase tracking-wide text-text-faint">
        {t("views.liveFloor.drawerReport")}
      </h4>
      {doc.isPending ? (
        <p className="px-2.5 py-2 ui-meta text-text-muted">{t("views.liveFloor.loading")}</p>
      ) : doc.error ? (
        <p role="alert" className="px-2.5 py-2 ui-meta text-status-blocked">
          {t("views.liveFloor.readError", {
            message: doc.error instanceof Error ? doc.error.message : String(doc.error),
          })}
        </p>
      ) : (doc.data?.body ?? "").trim() === "" ? (
        <p className="px-2.5 py-2 ui-meta text-text-faint">{t("views.liveFloor.drawerReportMissing")}</p>
      ) : (
        <div className="bounded-content px-3 py-2 text-sm text-text whitespace-pre-wrap [overflow-wrap:anywhere]">
          {doc.data?.body}
        </div>
      )}
    </section>
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { AgentRuntimeSessionDto } from "@harness-anything/daemon/protocol";
import type { TaskDispatchProjectionRow, TaskDispatchesRead } from "../../api/renderer-dto.ts";
import { harnessClient } from "../api-client.ts";
import { agentRuntimeClient, runtimeQueryKeys } from "../agent-runtime-client.ts";
import { t, type MessageKey } from "../i18n/index.tsx";
import { formatDuration, formatTime } from "../model/time.ts";
import type { WorkIndex } from "../model/work-collections.ts";
import { QUERY_PACING_MS } from "../query-pacing.ts";
import { PageHeader } from "../components/primitives/PageHeader.tsx";
import { Empty } from "../components/primitives/Empty.tsx";
import { StatusTag, type StatusTone } from "../components/primitives/StatusTag.tsx";
import { liveFloorActionSummary, liveFloorRows, liveFloorWorkGroups, readableModelName } from "./live-floor-model.ts";

const EMPTY_SESSIONS: readonly AgentRuntimeSessionDto[] = [];

export function LiveFloorView({
  repoId,
  taskTitles,
  works,
  onOpenTask,
}: {
  readonly repoId: string;
  readonly taskTitles: ReadonlyMap<string, string>;
  readonly works: WorkIndex;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const runtime = useQuery({
      queryKey: runtimeQueryKeys.overviewAll(repoId),
      queryFn: () => agentRuntimeClient.overview(repoId),
      staleTime: 4_000,
      refetchInterval: QUERY_PACING_MS.tokenUsage,
    }),
    sessions = runtime.data?.sessions ?? EMPTY_SESSIONS,
    taskIds = useMemo(
      () => [...new Set(sessions.flatMap((session) => session.associations.map(({ taskId }) => taskId)))].sort(),
      [sessions],
    ),
    dispatches = useQuery({
      queryKey: [...runtimeQueryKeys.dispatchesAll(repoId), "live-floor", taskIds.join("\0")],
      queryFn: async () => {
        if (taskIds.length === 0) return [] as readonly TaskDispatchProjectionRow[];
        const read = (await harnessClient.getTaskDispatches({ repoId, taskIds, limit: 500 })) as TaskDispatchesRead;
        return read.dispatches as readonly TaskDispatchProjectionRow[];
      },
      enabled: runtime.data !== undefined,
      staleTime: 4_000,
      refetchInterval: QUERY_PACING_MS.tokenUsage,
    }),
    liveRows = useMemo(
      () => liveFloorRows({ sessions, dispatches: dispatches.data ?? [], taskTitles, works }),
      [dispatches.data, sessions, taskTitles, works],
    ),
    groups = useMemo(() => liveFloorWorkGroups(liveRows), [liveRows]),
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
  const actionByDispatch = new Map<string, string>();
  let actionIndex = 0;
  for (const row of liveRows) {
    if (row.dispatch === null) continue;
    const read = actionReads[actionIndex++]?.data;
    if (read && read.status !== "gap" && read.status !== "unavailable") {
      const summary = liveFloorActionSummary(read.items.filter(isRecord));
      if (summary) actionByDispatch.set(row.dispatch.dispatchId, summary);
    }
  }

  const loading = runtime.isPending || (runtime.data !== undefined && dispatches.isPending),
    error = runtime.error ?? dispatches.error;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="live-floor-page">
      <PageHeader
        title={t("views.liveFloor.title")}
        note={t("views.liveFloor.note")}
        meta={runtime.data === undefined ? "—" : t("views.liveFloor.liveCount", { count: String(liveRows.length) })}
        testId="live-floor-header"
      />
      <div className="content-viewport min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {error ? (
          <p role="alert" className="py-3 ui-meta text-status-blocked">
            {t("views.liveFloor.readError", { message: error instanceof Error ? error.message : String(error) })}
          </p>
        ) : loading ? (
          <p className="py-3 ui-meta text-text-muted">{t("views.liveFloor.loading")}</p>
        ) : liveRows.length === 0 ? (
          <Empty>{t("views.liveFloor.empty")}</Empty>
        ) : (
          <section aria-label={t("views.liveFloor.sectionTitle")} data-testid="live-floor-running">
            <div className="flex items-baseline gap-2 border-b border-border py-2">
              <h2 className="text-base font-semibold text-text">{t("views.liveFloor.sectionTitle")}</h2>
              <span className="font-mono ui-meta text-text-faint">{liveRows.length}</span>
            </div>
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
                        onOpenTask={onOpenTask}
                      />
                    ))}
                  </div>
                </details>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function LiveFloorSessionRow({
  row,
  action,
  onOpenTask,
}: {
  readonly row: ReturnType<typeof liveFloorRows>[number];
  readonly action: string | null;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const roleKey: MessageKey =
      row.role === "implementation"
        ? "views.liveFloor.roleImplementation"
        : row.role === "reviewer"
          ? "views.liveFloor.roleReviewer"
          : row.role === "rework"
            ? "views.liveFloor.roleRework"
            : "views.liveFloor.roleUnknown",
    statusKey: MessageKey =
      row.activityStatus === "progressing"
        ? "views.liveFloor.statusProgressing"
        : row.activityStatus === "waiting_ci"
          ? "views.liveFloor.statusWaitingCi"
          : row.activityStatus === "stalled"
            ? "views.liveFloor.statusStalled"
            : "views.liveFloor.statusUnknown",
    tone: StatusTone =
      row.activityStatus === "stalled"
        ? "bad"
        : row.activityStatus === "waiting_ci"
          ? "wait"
          : row.activityStatus === "unknown"
            ? "neutral"
            : "active",
    model = readableModelName(row.model),
    duration = row.startedAt ? formatDuration(Date.now() - Date.parse(row.startedAt)) : null;
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
      <span className="min-w-0 truncate text-sm text-text-muted" title={action ?? undefined}>
        {action ?? t("views.liveFloor.noRecentAction")}
      </span>
      <span className="flex min-w-0 items-center gap-2 text-xs text-text-muted">
        <span className="truncate">{t(roleKey)}</span>
        <span aria-hidden="true">·</span>
        <span className="truncate" title={row.model ?? undefined}>
          {model ?? t("views.liveFloor.modelUnknown")}
        </span>
      </span>
      <span className="flex items-center justify-end gap-2">
        <StatusTag tone={tone} label={t(statusKey)} />
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

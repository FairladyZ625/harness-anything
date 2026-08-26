import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { agentEntityClient } from "../agent-entity-client.ts";
import { agentRuntimeClient } from "../agent-runtime-client.ts";
import { harnessClient } from "../api-client.ts";
import { t } from "../i18n/index.tsx";
import { Badge, Btn, Empty, SegCtl } from "../components/runtime/parts.tsx";
import { runtimeSelectionFromRef, useSessionsWorkspace } from "../components/runtime/useRuntimeWorkspace.ts";
import { SessionGroupList } from "../components/sessions/SessionGroupList.tsx";
import { SquadRunList } from "../components/sessions/SquadRunList.tsx";
import { SessionInspector } from "../components/sessions/SessionInspector.tsx";
import { SessionsPanel } from "../components/runtime/SessionsPanel.tsx";
import type { RelationEdge } from "../model/types.ts";
import {
  sessionDecisionRefs,
  sessionOrphans,
  sessionRounds,
  type SessionGroup,
  type SessionGroupBy,
  type SessionOrphan,
  type SessionRound,
} from "../sessions-model.ts";

/**
 * 会话页(设计稿 §2–§5):顶层两大段——单会话(默认,按 Task 分组)与小队编排
 * (一次 `ha squad run` 一个编排单元)。分组、范围与检索都在 daemon 侧完成
 * (sessionGroups / squad.runs.list),前端一次 RPC 拿组,不再翻 overview 分页、不再
 * 前端 join 派工台账。选择可寻址:session/<id>、tasksessions/<taskId>,导航回撤
 * 原路返回。
 */
type Segment = "sessions" | "squads";
type Range = "24h" | "7d" | "30d" | "all";
const RANGE_SPAN: Readonly<Record<Range, number>> = { "24h": 86_400, "7d": 7 * 86_400, "30d": 30 * 86_400, all: 0 };
const GROUP_ROWS_PENDING = { rounds: [] as readonly SessionRound[], orphans: [] as readonly SessionOrphan[] };

export function SessionsView({
  repoId,
  relations,
  focusedEntityRef,
  onSelectEntity,
  onOpenTask,
}: {
  readonly repoId: string;
  readonly relations: readonly RelationEdge[];
  readonly focusedEntityRef: string | null;
  readonly onSelectEntity: (ref: string) => void;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const [segment, setSegment] = useState<Segment>("sessions");
  const [groupBy, setGroupBy] = useState<SessionGroupBy>("task");
  const [range, setRange] = useState<Range>("24h");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [inspector, setInspector] = useState(true);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());
  const [sessionTaskScope, setSessionTaskScope] = useState<{
    readonly runtimeSessionId: string;
    readonly taskId: string;
  } | null>(null);
  const refSelection = runtimeSelectionFromRef(focusedEntityRef);
  const focusedSessionId = refSelection?.type === "session" ? refSelection.id : null;
  const taskRouteId = focusedEntityRef?.startsWith("tasksessions/")
    ? focusedEntityRef.slice("tasksessions/".length) || null
    : null;

  // 检索 150ms debounce(设计稿 §4):即时过滤,但 RPC 频率有界。
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 150);
    return () => window.clearTimeout(timer);
  }, [search]);

  // 深链落点:tasksessions/<taskId> 切单会话段、Task 分组并把读范围收窄到该
  // task;session/<id> 切单会话段,精确 read 返回后再展开其 task binding。
  useEffect(() => {
    if (focusedEntityRef === null) {
      setSessionTaskScope(null);
      return;
    }
    setSegment("sessions");
    if (focusedEntityRef.startsWith("tasksessions/")) {
      const taskId = focusedEntityRef.slice("tasksessions/".length);
      setGroupBy("task");
      setRange("all");
      setSessionTaskScope(null);
      setExpandedGroups((current) => new Set([...current, taskId]));
      return;
    }
    setSessionTaskScope((current) =>
      focusedSessionId !== null && current?.runtimeSessionId === focusedSessionId ? current : null,
    );
  }, [focusedEntityRef, focusedSessionId]);

  const since = useMemo(() => {
    const span = RANGE_SPAN[range];
    return new Date(span === 0 ? 0 : Date.now() - span * 1000).toISOString();
  }, [range]);

  const scopedTaskId =
    taskRouteId ?? (sessionTaskScope?.runtimeSessionId === focusedSessionId ? sessionTaskScope.taskId : undefined);
  const workspace = useSessionsWorkspace(repoId, {
    groupBy,
    range,
    since,
    query: debouncedSearch,
    ...(scopedTaskId === undefined ? {} : { taskId: scopedTaskId }),
  });
  const groups = workspace.groups.data?.groups ?? [],
    totals = workspace.groups.data?.totals ?? { groups: 0, sessions: 0 },
    truncated = workspace.groups.data?.truncated ?? false;
  const runs = workspace.squadRuns.data?.runs ?? [],
    runTotals = workspace.squadRuns.data?.totals ?? { runs: 0 };

  // 检索单组命中时自动展开(设计稿 §7.1:命中 1 组 1 轮,组自动展开)。
  useEffect(() => {
    if (debouncedSearch === "" || groupBy !== "task" || groups.length !== 1 || groups[0]?.kind !== "task") return;
    const key = groups[0]!.key;
    setExpandedGroups((current) => (current.has(key) ? current : new Set([...current, key])));
  }, [debouncedSearch, groupBy, groups]);

  // 组展开行集:每个已展开任务组两次读(task.dispatches 全部轮次 + overview { taskId }
  // 绑定会话做孤儿判定)。数据在页级持有,组列表、主区与 inspector 共用缓存键。
  const expandedTasks = useMemo(
    () =>
      groups.filter(
        (group): group is SessionGroup & { readonly taskId: string } =>
          group.kind === "task" && group.taskId !== undefined && expandedGroups.has(group.key),
      ),
    [groups, expandedGroups],
  );
  const roundsQueries = useQueries({
    queries: expandedTasks.map((group) => ({
      queryKey: ["sessions-page", repoId, "rounds", group.taskId],
      queryFn: () => harnessClient.getTaskDispatches({ repoId, taskId: group.taskId }),
      staleTime: 4_000,
    })),
  });
  const taskSessionQueries = useQueries({
    queries: expandedTasks.map((group) => ({
      queryKey: ["sessions-page", repoId, "task-sessions", group.taskId],
      queryFn: () => agentRuntimeClient.overview(repoId, group.taskId),
      staleTime: 4_000,
    })),
  });
  const groupRows = useMemo(() => {
    const rows = new Map<
      string,
      {
        rounds: readonly SessionRound[];
        orphans: readonly SessionOrphan[];
        pending: boolean;
        error: string | null;
      }
    >();
    expandedTasks.forEach((group, index) => {
      const roundsQuery = roundsQueries[index],
        sessionsQuery = taskSessionQueries[index],
        dispatches = roundsQuery?.data?.dispatches;
      if (dispatches === undefined && !roundsQuery?.isError) {
        rows.set(group.key, { ...GROUP_ROWS_PENDING, pending: true, error: null });
        return;
      }
      if (roundsQuery?.isError) {
        rows.set(group.key, {
          ...GROUP_ROWS_PENDING,
          pending: false,
          error: roundsQuery.error instanceof Error ? roundsQuery.error.message : String(roundsQuery.error),
        });
        return;
      }
      const rounds = sessionRounds(group.taskId, group.label, dispatches ?? []);
      rows.set(group.key, {
        rounds,
        orphans: sessionOrphans(group.taskId, group.label, sessionsQuery?.data?.sessions ?? [], rounds),
        pending: false,
        error: null,
      });
    });
    return rows;
  }, [expandedTasks, roundsQueries, taskSessionQueries]);

  // 深链 session/<id> 始终先成为精确选择;存在性与 task binding 由同一个
  // repo.agentRuntime.sessions.read 判定,绝不因组尚未展开而改选首组 latestRound。
  const allRows = useMemo(
    () => [...groupRows.values()].flatMap(({ rounds, orphans }) => [...rounds, ...orphans]),
    [groupRows],
  );
  const defaultSessionId =
      groups.find(({ latestRound }) => latestRound !== null)?.latestRound?.runtimeSessionId ?? null,
    selectedSessionId = focusedSessionId ?? defaultSessionId;
  const selectedSession = useQuery({
    queryKey: ["sessions-page", repoId, "session", selectedSessionId],
    queryFn: () => agentRuntimeClient.session(repoId, selectedSessionId!),
    enabled: selectedSessionId !== null,
    staleTime: 4_000,
  });
  useEffect(() => {
    const session = selectedSession.data?.session;
    if (focusedSessionId === null || session?.runtimeSessionId !== focusedSessionId) return;
    const taskIds = [...new Set(session.associations.map(({ taskId }) => taskId))];
    if (taskIds.length === 0) return;
    setGroupBy("task");
    setExpandedGroups((current) => {
      const next = new Set(current);
      taskIds.forEach((taskId) => next.add(taskId));
      return next.size === current.size ? current : next;
    });
    // A range-key change has no data until its read settles. Treating that pending state as an
    // absent deep-link target forced `all` and issued a second sessionGroups read for one click.
    if (workspace.groups.data === undefined) return;
    if (groups.some((group) => group.taskId !== undefined && taskIds.includes(group.taskId))) return;
    setRange("all");
    setSessionTaskScope((current) =>
      current?.runtimeSessionId === focusedSessionId && current.taskId === taskIds[0]
        ? current
        : { runtimeSessionId: focusedSessionId, taskId: taskIds[0]! },
    );
  }, [focusedSessionId, groups, selectedSession.data, workspace.groups.data]);
  const selectedRow =
    selectedSessionId === null ? null : (allRows.find((row) => row.runtimeSessionId === selectedSessionId) ?? null);
  const selectedTaskId = selectedRow?.taskId ?? selectedSession.data?.session.associations[0]?.taskId ?? null;
  const siblings =
    selectedRow === null
      ? []
      : allRows.filter(
          (row) => row.taskId === selectedRow.taskId && row.runtimeSessionId !== selectedRow.runtimeSessionId,
        );
  const liveCount = groups.reduce((total, group) => total + group.runningCount, 0);
  const activeRunCount = runs.filter((run) => run.phase !== "converged" && run.phase !== "failed").length;

  const squads = useQuery({
    queryKey: ["squads", repoId],
    queryFn: () => agentEntityClient.listSquads(repoId),
    staleTime: 4_000,
  });
  const squadNames = useMemo(() => new Map((squads.data ?? []).map((squad) => [squad.id, squad.name])), [squads.data]);

  const rangeLabel: Record<Range, string> = {
    "24h": "24h",
    "7d": "7d",
    "30d": "30d",
    all: t("agentRuntime.sessionsRangeAll"),
  };
  const visibleRead = segment === "sessions" ? workspace.groups : workspace.squadRuns;
  const visibleReadError = visibleRead.error instanceof Error ? visibleRead.error.message : String(visibleRead.error);
  return (
    <section data-testid="sessions-view" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-[42px] shrink-0 items-center gap-3 border-b border-border bg-surface-raised px-3.5">
        <b className="text-[13px] tracking-[0.02em]">{t("agentRuntime.sessionsTitle")}</b>
        <SegCtl
          label={t("agentRuntime.sessionsSegmentLabel")}
          value={segment}
          onChange={(value) => setSegment(value)}
          options={[
            { value: "sessions", label: t("agentRuntime.sessionsSegmentSingle") },
            { value: "squads", label: t("agentRuntime.sessionsSegmentSquad") },
          ]}
        />
        <span className="flex-1" />
        {segment === "sessions" ? (
          <Badge status={liveCount > 0 ? "active" : "planned"}>
            {t("agentRuntime.liveSessions", { count: liveCount })}
          </Badge>
        ) : (
          <Badge status={activeRunCount > 0 ? "active" : "planned"}>
            {t("agentRuntime.squadRunsActive", { count: activeRunCount })}
          </Badge>
        )}
        {segment === "sessions" && (
          <Btn
            size="sm"
            variant="ghost"
            onClick={() => setInspector(!inspector)}
            tip={t("agentRuntime.toggleInspector")}
          >
            ▐
          </Btn>
        )}
      </header>
      <div className="flex h-[34px] shrink-0 items-center gap-2.5 border-b border-border bg-surface px-3.5">
        {segment === "sessions" && (
          <SegCtl
            label={t("agentRuntime.sessionsGroupByLabel")}
            value={groupBy}
            onChange={(value) => setGroupBy(value)}
            options={[
              { value: "task", label: t("agentRuntime.sessionsGroupTask") },
              { value: "squad", label: t("agentRuntime.sessionsGroupSquad") },
              { value: "agent", label: t("agentRuntime.sessionsGroupAgent") },
              { value: "day", label: t("agentRuntime.sessionsGroupDay") },
            ]}
          />
        )}
        <SegCtl
          label={t("agentRuntime.sessionsRangeLabel")}
          value={range}
          onChange={(value) => setRange(value)}
          options={(Object.keys(RANGE_SPAN) as Range[]).map((value) => ({ value, label: rangeLabel[value] }))}
        />
        <input
          type="search"
          data-testid="sessions-search"
          aria-label={t("agentRuntime.sessionsSearchLabel")}
          placeholder={t("agentRuntime.sessionsSearchPlaceholder")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className={
            "w-[280px] rounded border border-border-strong bg-surface px-2 py-1 text-[11.5px] text-text " +
            "outline-none focus-visible:border-accent"
          }
        />
        <span className="ml-auto truncate font-mono text-[10px] text-text-faint">
          {segment === "sessions"
            ? t("agentRuntime.sessionsCounts", {
                range: rangeLabel[range],
                groups: totals.groups,
                sessions: totals.sessions,
              })
            : t("agentRuntime.squadRunsCounts", { range: rangeLabel[range], runs: runTotals.runs })}
        </span>
      </div>
      {visibleRead.isError && (
        <p
          role="alert"
          data-testid="runtime-read-error"
          className="shrink-0 border-b border-border bg-status-blocked/10 px-3.5 py-1.5 font-mono text-[11px]
        text-status-blocked"
        >
          {t("agentRuntime.readFailed", {
            error: visibleReadError,
          })}
        </p>
      )}
      {(workspace.error ?? workspace.feedback) && (
        <p
          role="status"
          onClick={workspace.clearFeedback}
          className={`shrink-0 border-b border-border px-3.5 py-1.5 font-mono text-[11px] ${
            workspace.error ? "bg-status-blocked/10 text-status-blocked" : "text-text-muted"
          }`}
        >
          {workspace.error ?? workspace.feedback}
        </p>
      )}
      {segment === "sessions" ? (
        <div className="flex min-h-0 flex-1">
          <SessionGroupList
            groups={groups}
            truncated={truncated}
            expandedKeys={expandedGroups}
            rowsByGroup={groupRows}
            selectedId={selectedSessionId}
            query={debouncedSearch}
            decisionRefsFor={(taskId) => sessionDecisionRefs(relations, taskId)}
            onSelectSession={(runtimeSessionId) => onSelectEntity(`session/${runtimeSessionId}`)}
            onToggleGroup={(key) =>
              setExpandedGroups((current) => {
                const next = new Set(current);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })
            }
            onOpenTask={onOpenTask}
            onSelectEntity={onSelectEntity}
          />
          <main className="min-w-0 flex-1 overflow-y-auto px-4 pt-3.5 pb-6">
            {selectedSessionId === null ? (
              <Empty>{t(workspace.groups.isPending ? "agentRuntime.loading" : "agentRuntime.noSessions")}</Empty>
            ) : (
              <SessionsPanel
                repoId={repoId}
                runtimeSessionId={selectedSessionId}
                snapshot={selectedSession.data ?? null}
                snapshotError={
                  selectedSession.isError
                    ? selectedSession.error instanceof Error
                      ? selectedSession.error.message
                      : String(selectedSession.error)
                    : null
                }
                row={selectedRow}
                squadNames={squadNames}
                decisionRefs={selectedTaskId === null ? [] : sessionDecisionRefs(relations, selectedTaskId)}
                busy={workspace.busy}
                onCancel={(runtimeSessionId) => void workspace.cancelSession(runtimeSessionId)}
                onOpenTask={onOpenTask}
                onNavigateEntity={onSelectEntity}
              />
            )}
          </main>
          {inspector && (
            <SessionInspector
              row={selectedRow}
              siblings={siblings}
              squadNames={squadNames}
              onSelectSession={(runtimeSessionId) => onSelectEntity(`session/${runtimeSessionId}`)}
              onOpenTask={onOpenTask}
              onSelectEntity={onSelectEntity}
            />
          )}
        </div>
      ) : (
        <SquadRunList
          runs={runs}
          truncated={workspace.squadRuns.data?.truncated ?? false}
          totalRuns={runTotals.runs}
          squadNames={squadNames}
          query={debouncedSearch}
          onOpenTask={onOpenTask}
        />
      )}
    </section>
  );
}

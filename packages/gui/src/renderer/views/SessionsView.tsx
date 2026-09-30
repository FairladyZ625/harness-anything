import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { isAvailableSquadRunSummary } from "@harness-anything/daemon/protocol";
import { agentEntityClient, isAvailableSquadEntityRow } from "../agent-entity-client.ts";
import { agentRuntimeClient, runtimeQueryKeys } from "../agent-runtime-client.ts";
import { harnessClient } from "../api-client.ts";
import { t } from "../i18n/index.tsx";
import { Btn, Empty, SegCtl } from "../components/runtime/parts.tsx";
import { Drawer } from "../components/primitives/Drawer.tsx";
import { StatusTag } from "../components/primitives/StatusTag.tsx";
import {
  runtimeSelectionFromRef,
  useSessionsWorkspace,
  useSquadRunDetail,
} from "../components/runtime/useRuntimeWorkspace.ts";
import { SessionGroupList, type DecisionGroupRows } from "../components/sessions/SessionGroupList.tsx";
import { DecisionReviewSessionCard } from "../components/sessions/DecisionReviewSessionCard.tsx";
import { decisionReviewRounds } from "../model/decision-review.ts";
import { decisionSessionsLocation } from "../navigation/decisionReviewRoutes.ts";
import { adaptDecisionRows, triadicQueryKeys } from "../triadic-data.ts";
import { SquadRunList } from "../components/sessions/SquadRunList.tsx";
import { SquadRunDetail } from "../components/sessions/SquadRunDetail.tsx";
import { SessionInspector } from "../components/sessions/SessionInspector.tsx";
import { SessionsPanel } from "../components/runtime/SessionsPanel.tsx";
import type { RelationEdge } from "../model/types.ts";
import {
  sessionDecisionRefs,
  sessionOrphans,
  sessionRounds,
  sessionStatusFilterWords,
  sessionStatusKey,
  type SessionGroup,
  type SessionGroupBy,
  type SessionOrphan,
  type SessionRound,
  type SessionStatus,
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
// 两段各自的默认读范围(G12 §2a):单会话段看「最近在干什么」用 24h;小队编排段
// 的一次 `ha squad run` 是长生命周期单元,terminal run 只靠 latestActivityAt 过窗,
// 默认 24h 会把已收敛/已失败的编排整段滤成无解释的空列表,默认放宽到 30d。
const DEFAULT_RANGE: Readonly<Record<Segment, Range>> = { sessions: "24h", squads: "30d" };
const GROUP_ROWS_PENDING = { rounds: [] as readonly SessionRound[], orphans: [] as readonly SessionOrphan[] };
const rangeToSince = (range: Range): string => {
  const span = RANGE_SPAN[range];
  return new Date(span === 0 ? 0 : Date.now() - span * 1000).toISOString();
};

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
  const [rangeBySegment, setRangeBySegment] = useState<Readonly<Record<Segment, Range>>>(DEFAULT_RANGE);
  const range = rangeBySegment[segment],
    setRange = (value: Range) => setRangeBySegment((current) => ({ ...current, [segment]: value }));
  const [search, setSearch] = useState("");
  // 状态筛选是集合:排障常要「失败或丢失」,而检索框的词之间是 AND,写不出这个。
  const [statusFilter, setStatusFilter] = useState<ReadonlySet<SessionStatus>>(new Set());
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [inspector, setInspector] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());
  const [selectedSquadRunId, setSelectedSquadRunId] = useState<string | null>(null);
  const [sessionTaskScope, setSessionTaskScope] = useState<{
    readonly runtimeSessionId: string;
    readonly taskId: string;
  } | null>(null);
  const refSelection = runtimeSelectionFromRef(focusedEntityRef);
  const focusedSessionId = refSelection?.type === "session" ? refSelection.id : null;
  const taskRouteId = focusedEntityRef?.startsWith("tasksessions/")
    ? focusedEntityRef.slice("tasksessions/".length) || null
    : null;
  // Decision 评审会话的落点(decisionsessions/<decisionId>[/<runtimeSessionId>]):按被评审
  // Decision 归组(daemon 按派工头 reviewTarget 分组),不从 session.taskId 猜 Decision。
  const decisionFocus = decisionSessionsLocation(focusedEntityRef);

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
    if (decisionFocus !== null) {
      setGroupBy("task");
      setRangeBySegment((current) => (current.sessions === "all" ? current : { ...current, sessions: "all" }));
      setSessionTaskScope(null);
      setExpandedGroups((current) =>
        current.has(decisionFocus.decisionId) ? current : new Set([...current, decisionFocus.decisionId]),
      );
      return;
    }
    if (focusedEntityRef.startsWith("tasksessions/")) {
      const taskId = focusedEntityRef.slice("tasksessions/".length);
      setGroupBy("task");
      setRangeBySegment((current) => (current.sessions === "all" ? current : { ...current, sessions: "all" }));
      setSessionTaskScope(null);
      setExpandedGroups((current) => new Set([...current, taskId]));
      return;
    }
    setSessionTaskScope((current) =>
      focusedSessionId !== null && current?.runtimeSessionId === focusedSessionId ? current : null,
    );
    // decisionFocus 由 focusedEntityRef 派生,依赖 ref 本身即可。
  }, [focusedEntityRef, focusedSessionId]);

  // 两段各自的读窗:单会话段与会话分组共用,小队编排段独立(见 DEFAULT_RANGE)。
  const since = useMemo(() => rangeToSince(rangeBySegment.sessions), [rangeBySegment.sessions]),
    squadSince = useMemo(() => rangeToSince(rangeBySegment.squads), [rangeBySegment.squads]);

  const scopedTaskId =
    taskRouteId ?? (sessionTaskScope?.runtimeSessionId === focusedSessionId ? sessionTaskScope.taskId : undefined);
  // 词表顺序取自 daemon,选择集只做筛选不做排序;空集合 = 不筛。
  const status = useMemo(() => sessionStatusFilterWords.filter((word) => statusFilter.has(word)), [statusFilter]);
  const workspace = useSessionsWorkspace(repoId, {
    groupBy,
    range,
    since,
    squadSince,
    query: debouncedSearch,
    status,
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
      queryKey: runtimeQueryKeys.dispatches(repoId, group.taskId),
      queryFn: () => harnessClient.getTaskDispatches({ repoId, taskId: group.taskId }),
      staleTime: 4_000,
    })),
  });
  const taskSessionQueries = useQueries({
    queries: expandedTasks.map((group) => ({
      queryKey: runtimeQueryKeys.overview(repoId, group.taskId),
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

  // Decision 组展开行:该组的评审派工在 Decision full 行上(reviewDispatches),与决策池/详情
  // 共用同一缓存键;只有展开 Decision 组或落 Decision 会话深链时才读,着陆不增加读请求。
  const expandedDecisionIds = useMemo(
    () =>
      groups.flatMap((group) =>
        group.kind === "decision" && group.decisionId !== undefined && expandedGroups.has(group.key)
          ? [group.decisionId]
          : [],
      ),
    [groups, expandedGroups],
  );
  const decisionRowsQuery = useQuery({
    queryKey: triadicQueryKeys.decisions(repoId),
    queryFn: () => harnessClient.getDecisions({ repoId }),
    enabled: expandedDecisionIds.length > 0 || decisionFocus?.runtimeSessionId != null,
    staleTime: 10_000,
  });
  const reviewedDecisions = useMemo(
    () => adaptDecisionRows(decisionRowsQuery.data?.decisions ?? [], [], []),
    [decisionRowsQuery.data],
  );
  const decisionGroupRows = useMemo(() => {
    const rows = new Map<string, DecisionGroupRows>();
    for (const decisionId of expandedDecisionIds) {
      const decision = reviewedDecisions.find((row) => row.decisionId === decisionId);
      rows.set(decisionId, {
        title: decision?.title ?? null,
        rounds: decision ? decisionReviewRounds(decision) : null,
        pending: decisionRowsQuery.isPending,
        error: decisionRowsQuery.isError
          ? decisionRowsQuery.error instanceof Error
            ? decisionRowsQuery.error.message
            : String(decisionRowsQuery.error)
          : null,
      });
    }
    return rows;
  }, [
    expandedDecisionIds,
    reviewedDecisions,
    decisionRowsQuery.isPending,
    decisionRowsQuery.isError,
    decisionRowsQuery.error,
  ]);
  const selectedReviewRound = useMemo(() => {
    if (decisionFocus?.runtimeSessionId == null) return null;
    const decision = reviewedDecisions.find((row) => row.decisionId === decisionFocus.decisionId);
    return (
      (decision ? decisionReviewRounds(decision) : null)?.find(
        (round) => round.dispatch.runtimeSessionId === decisionFocus.runtimeSessionId,
      ) ?? null
    );
  }, [decisionFocus?.decisionId, decisionFocus?.runtimeSessionId, reviewedDecisions]);

  // 深链 session/<id> 始终先成为精确选择;存在性与 task binding 由同一个
  // repo.agentRuntime.sessions.read 判定,绝不因组尚未展开而改选首组 latestRound。
  const allRows = useMemo(
    () => [...groupRows.values()].flatMap(({ rounds, orphans }) => [...rounds, ...orphans]),
    [groupRows],
  );
  const selectedSessionId = decisionFocus?.runtimeSessionId ?? focusedSessionId;
  useEffect(() => {
    setInspector(selectedSessionId !== null);
  }, [selectedSessionId]);
  const selectedSession = useQuery({
    queryKey: runtimeQueryKeys.session(repoId, selectedSessionId ?? ""),
    queryFn: () => agentRuntimeClient.session(repoId, selectedSessionId!),
    enabled: selectedSessionId !== null,
    staleTime: 4_000,
  });
  // 深链补展开只对该 session 焦点应用一次(G12 §1a):ref 记住已应用的
  // focusedSessionId,之后的组数据刷新/维度切换不再把 groupBy/range 压回深链值——
  // 用户切到 Squad/Agent/时间维度时不再被弹回 Task。
  const appliedFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (focusedSessionId === null) {
      appliedFocusRef.current = null;
      return;
    }
    const session = selectedSession.data?.session;
    if (session?.runtimeSessionId !== focusedSessionId) return;
    if (appliedFocusRef.current === focusedSessionId) return;
    const taskIds = [...new Set(session.associations.map(({ taskId }) => taskId))];
    if (taskIds.length === 0) return;
    appliedFocusRef.current = focusedSessionId;
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
    setRangeBySegment((current) => (current.sessions === "all" ? current : { ...current, sessions: "all" }));
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
  const availableRuns = runs.filter(isAvailableSquadRunSummary);
  const activeRunCount = availableRuns.filter((run) => run.phase !== "converged" && run.phase !== "failed").length;

  const squads = useQuery({
    queryKey: ["squads", repoId],
    queryFn: () => agentEntityClient.listSquads(repoId),
    staleTime: 4_000,
  });
  const squadNames = useMemo(
    () => new Map((squads.data ?? []).filter(isAvailableSquadEntityRow).map((squad) => [squad.id, squad.name])),
    [squads.data],
  );

  // 组列表的行回调用 useCallback 稳定:App 层台账探针每 ~2s 推进一次 cut 都会让本页
  // 重渲染,行级 memo(SessionGroupList 的 GroupSection)靠这些稳定引用跳过未变组。
  const groupDecisionRefsFor = useCallback((taskId: string) => sessionDecisionRefs(relations, taskId), [relations]);
  const selectSessionFromRail = useCallback(
    (runtimeSessionId: string) => {
      setInspector(true);
      onSelectEntity(`session/${runtimeSessionId}`);
    },
    [onSelectEntity],
  );
  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // 小队编排详情(G12 §2b/§2c):选中行的 repo.squad.run.read,渲染 leader 轮次 →
  // worker 派工链扇出树;只有显式点击行才读取详情,切换范围后若该 run 不在列表则
  // 回到空选中。读面收敛在 useSquadRunDetail(与失效键同源)。
  const selectedSquadRun =
    selectedSquadRunId === null ? null : (availableRuns.find((run) => run.squadRunId === selectedSquadRunId) ?? null);
  const squadRunDetail = useSquadRunDetail(
    repoId,
    segment === "squads" && selectedSquadRun !== null ? selectedSquadRun.squadRunId : null,
  );

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
      <header className="glass mx-2 mt-2 flex min-h-[42px] shrink-0 items-center gap-3 rounded-sm border border-border px-3.5">
        <div className="min-w-0">
          <b className="block ui-body tracking-[0.02em]">{t("agentRuntime.sessionsTitle")}</b>
        </div>
        <SegCtl
          label={t("agentRuntime.sessionsSegmentLabel")}
          value={segment}
          onChange={(value) => setSegment(value)}
          options={[
            { value: "sessions", label: t("agentRuntime.sessionsSegmentSingle") },
            { value: "squads", label: t("agentRuntime.sessionsSegmentSquad") },
          ]}
        />
        <span data-testid="sessions-counts" className="ml-auto truncate font-mono ui-micro text-text-faint">
          {segment === "sessions"
            ? t("agentRuntime.sessionsCounts", {
                range: rangeLabel[range],
                groups: totals.groups,
                sessions: totals.sessions,
              }) +
              // 计数是 daemon 按过滤后的集合算的,所以筛选生效时把它说出来——
              // 否则用户读到的是「会话消失了」而不是「这是筛后的数」。
              (status.length === 0
                ? ""
                : t("agentRuntime.sessionsStatusFilterNote", {
                    statuses: status.map((word) => t(sessionStatusKey[word] as never)).join(" / "),
                  }))
            : t("agentRuntime.squadRunsCounts", { range: rangeLabel[range], runs: runTotals.runs })}
        </span>
        {segment === "sessions" ? (
          <StatusTag
            tone={liveCount > 0 ? "active" : "plan"}
            label={t("agentRuntime.liveSessions", { count: liveCount })}
          />
        ) : (
          <StatusTag
            tone={activeRunCount > 0 ? "active" : "plan"}
            label={t("agentRuntime.squadRunsActive", { count: activeRunCount })}
          />
        )}
        {segment === "sessions" && selectedSessionId !== null && (
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
      <div
        data-testid="sessions-toolbar"
        className="glass mx-2 flex min-h-10 shrink-0 flex-nowrap items-center gap-2 overflow-x-auto border-b border-border px-1.5 [&>span[role=group]]:flex-nowrap [&>span[role=group]]:shrink-0 [&_button]:whitespace-nowrap"
      >
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
        {segment === "sessions" && (
          <span
            role="group"
            aria-label={t("agentRuntime.sessionsStatusLabel")}
            data-testid="sessions-status-filter"
            className="inline-flex min-w-24 flex-1 gap-1 overflow-x-auto py-1 [&>button]:shrink-0"
            style={{ flexShrink: 1 }}
          >
            {sessionStatusFilterWords.map((word) => (
              <button
                key={word}
                type="button"
                data-testid={`sessions-status-${word}`}
                aria-pressed={statusFilter.has(word)}
                onClick={() =>
                  setStatusFilter((current) => {
                    const next = new Set(current);
                    if (next.has(word)) next.delete(word);
                    else next.add(word);
                    return next;
                  })
                }
                className={`h-6 whitespace-nowrap rounded-xs border px-2.5 ui-micro ${
                  statusFilter.has(word)
                    ? "border-accent/40 bg-accent/15 font-semibold text-accent"
                    : "border-border bg-text/5 text-text-muted hover:bg-surface"
                }`}
              >
                {t(sessionStatusKey[word] as never)}
              </button>
            ))}
          </span>
        )}
        <input
          type="search"
          data-testid="sessions-search"
          aria-label={t("agentRuntime.sessionsSearchLabel")}
          placeholder={t("agentRuntime.sessionsSearchPlaceholder")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className={
            "w-48 shrink-0 rounded-xs border border-border-strong bg-surface px-2 py-1 ui-micro text-text " +
            "outline-none focus-visible:border-accent"
          }
        />
      </div>
      {visibleRead.isError && (
        <p
          role="alert"
          data-testid="runtime-read-error"
          className="shrink-0 border-b border-border bg-status-blocked/10 px-3.5 py-1.5 font-mono ui-micro
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
          className={`shrink-0 border-b border-border px-3.5 py-1.5 font-mono ui-micro ${
            workspace.error ? "bg-status-blocked/10 text-status-blocked" : "text-text-muted"
          }`}
        >
          {workspace.error ?? workspace.feedback}
        </p>
      )}
      {segment === "sessions" ? (
        <div className="flex min-h-0 flex-1 px-2 pb-2">
          <SessionGroupList
            pending={workspace.groups.isPending}
            groups={groups}
            truncated={truncated}
            expandedKeys={expandedGroups}
            rowsByGroup={groupRows}
            decisionRowsByGroup={decisionGroupRows}
            selectedId={selectedSessionId}
            query={debouncedSearch}
            decisionRefsFor={groupDecisionRefsFor}
            onSelectSession={selectSessionFromRail}
            onToggleGroup={toggleGroup}
            onOpenTask={onOpenTask}
            onSelectEntity={onSelectEntity}
          />
          {selectedSessionId !== null && (
            <Drawer
              open={inspector}
              onClose={() => setInspector(false)}
              ariaLabel={t("agentRuntime.inspectorSession")}
              modal={false}
            >
              {selectedReviewRound && (
                <DecisionReviewSessionCard round={selectedReviewRound} onNavigateEntity={onSelectEntity} />
              )}
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
                onResume={async (dispatchId) => {
                  const settled = await workspace.resumeDispatch(dispatchId);
                  if (settled?.state === "applied" && settled.runtimeSessionId)
                    onSelectEntity(`session/${settled.runtimeSessionId}`);
                }}
                onOpenTask={onOpenTask}
                onNavigateEntity={onSelectEntity}
              />
              {selectedRow !== null && (
                <SessionInspector
                  row={selectedRow}
                  siblings={siblings}
                  squadNames={squadNames}
                  onSelectSession={(runtimeSessionId) => onSelectEntity(`session/${runtimeSessionId}`)}
                  onOpenTask={onOpenTask}
                  onSelectEntity={onSelectEntity}
                />
              )}
            </Drawer>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 px-2 pb-2">
          <SquadRunList
            runs={runs}
            truncated={workspace.squadRuns.data?.truncated ?? false}
            totalRuns={runTotals.runs}
            squadNames={squadNames}
            query={debouncedSearch}
            range={rangeLabel[rangeBySegment.squads]}
            selectedId={selectedSquadRun?.squadRunId ?? null}
            onSelectRun={setSelectedSquadRunId}
          />
          <main className="min-w-0 flex-1 overflow-y-auto">
            {selectedSquadRun === null ? (
              <Empty>{t("agentRuntime.squadRunSelectEmpty")}</Empty>
            ) : (
              <SquadRunDetail
                detail={squadRunDetail.data ?? null}
                squadName={squadNames.get(selectedSquadRun.squadId) ?? null}
                pending={squadRunDetail.isPending}
                error={
                  squadRunDetail.isError
                    ? squadRunDetail.error instanceof Error
                      ? squadRunDetail.error.message
                      : String(squadRunDetail.error)
                    : null
                }
                onOpenTask={onOpenTask}
                onSelectEntity={onSelectEntity}
              />
            )}
          </main>
        </div>
      )}
    </section>
  );
}

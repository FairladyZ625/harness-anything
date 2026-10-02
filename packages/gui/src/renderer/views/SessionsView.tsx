import { SegCtl } from "../components/primitives/SegCtl.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { isAvailableSquadRunSummary } from "@harness-anything/daemon/protocol";
import { Popover } from "../components/Popover.tsx";
import { agentEntityClient, isAvailableSquadEntityRow } from "../agent-entity-client.ts";
import { agentRuntimeClient, runtimeQueryKeys } from "../agent-runtime-client.ts";
import { harnessClient } from "../api-client.ts";
import { t } from "../i18n/index.tsx";
import { workspaceTitleIndex } from "../model/workspace-readable.ts";
import { useTasksQuery } from "../task-data.ts";
import { Empty } from "../components/primitives/Empty.tsx";
import { CatalogBackButton, CatalogSplit, useCatalogDetailPane } from "../components/primitives/CatalogSplit.tsx";
import { PageHeader } from "../components/primitives/PageHeader.tsx";
import { Button } from "../components/primitives/Button.tsx";
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
 * 会话页(设计稿 §2–§5;标准 §2.5 v2 与 Agent 页同构:左列表、右常驻详情,不用抽屉):顶层两大段——单会话(默认,按 Task 分组)与小队编排
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
// 无显式选中时右侧落在第一条需要关注的会话(在跑/失败/丢失),没有则落最新一条。
const ATTENTION_STATUSES: ReadonlySet<SessionStatus> = new Set(["running", "failed", "lost"]);
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
  const [inspector, setInspector] = useState(true);
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

  // 窄容器(内容区 <720px,styles.css .catalog-split)的单列形态:点行进详情、返回键回
  // 列表;宽容器常驻双栏,该状态不参与显隐。深链/跨页实体跳转让详情取代列表(等价一次
  // 点行);返回键只清 open,不动导航栈。机制与小组件在 primitives/CatalogSplit。
  const narrow = useCatalogDetailPane(focusedSessionId ?? decisionFocus?.runtimeSessionId ?? null);

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

  // Decision 组:daemon 组行只带 decisionId,组头标题与展开行都取 Decision full 行(标题、
  // reviewDispatches),与决策池/详情共用同一缓存键;列表里有 Decision 组或落 Decision 会话深链时才读。
  const decisionGroupIds = useMemo(
    () =>
      groups.flatMap((group) =>
        group.kind === "decision" && group.decisionId !== undefined ? [group.decisionId] : [],
      ),
    [groups],
  );
  const decisionRowsQuery = useQuery({
    queryKey: triadicQueryKeys.decisions(repoId),
    queryFn: () => harnessClient.getDecisions({ repoId }),
    enabled: decisionGroupIds.length > 0 || decisionFocus?.runtimeSessionId != null,
    staleTime: 10_000,
  });
  const reviewedDecisions = useMemo(
    () => adaptDecisionRows(decisionRowsQuery.data?.decisions ?? [], [], []),
    [decisionRowsQuery.data],
  );
  const decisionGroupRows = useMemo(() => {
    const rows = new Map<string, DecisionGroupRows>();
    for (const decisionId of decisionGroupIds) {
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
    decisionGroupIds,
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
  const defaultSessionId =
      (
        groups.find((group) => group.latestRound !== null && ATTENTION_STATUSES.has(group.latestStatus)) ??
        groups.find((group) => group.latestRound !== null)
      )?.latestRound?.runtimeSessionId ?? null,
    selectedSessionId = decisionFocus?.runtimeSessionId ?? focusedSessionId ?? defaultSessionId;
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

  // `task/<id>` → 标题索引(与 App 同一常驻任务列表投影、同一 helper,缓存键共享不加读面):
  // 详情「任务」框的主文字用任务标题,查不到才显示 id(视觉基线 v2)。
  const tasksQuery = useTasksQuery(repoId);
  const taskTitles = useMemo(
    () =>
      workspaceTitleIndex({
        tasks: (tasksQuery.data?.rows ?? []).map(({ taskId, snapshot }) => ({
          taskId,
          title: snapshot.task?.title ?? "",
        })),
        facts: [],
        decisions: [],
      }),
    [tasksQuery.data],
  );

  // 组列表的行回调用 useCallback 稳定:App 层台账探针每 ~2s 推进一次 cut 都会让本页
  // 重渲染,行级 memo(SessionGroupList 的 GroupSection)靠这些稳定引用跳过未变组。
  const groupDecisionRefsFor = useCallback((taskId: string) => sessionDecisionRefs(relations, taskId), [relations]);
  const selectSessionFromRail = useCallback(
    (runtimeSessionId: string) => {
      narrow.openDetail();
      onSelectEntity(`session/${runtimeSessionId}`);
    },
    [narrow.openDetail, onSelectEntity],
  );
  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const toggleStatusFilter = useCallback((word: SessionStatus) => {
    setStatusFilter((current) => {
      const next = new Set(current);
      if (next.has(word)) next.delete(word);
      else next.add(word);
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
      <PageHeader
        title={t("agentRuntime.sessionsTitle")}
        note={
          <span data-testid="sessions-counts" className="truncate">
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
                    })) +
                " · " +
                t("agentRuntime.liveSessions", { count: liveCount })
              : t("agentRuntime.squadRunsCounts", { range: rangeLabel[range], runs: runTotals.runs }) +
                " · " +
                t("agentRuntime.squadRunsActive", { count: activeRunCount })}
          </span>
        }
        actions={
          segment === "sessions" && selectedSessionId !== null ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setInspector(!inspector)}
              tip={t("agentRuntime.toggleInspector")}
            >
              ▐
            </Button>
          ) : undefined
        }
      />
      <div
        data-testid="sessions-toolbar"
        className="flex min-h-12 shrink-0 flex-wrap items-center gap-2.5 px-5 py-2 @container [&>span[role=group]]:shrink-0 [&_button]:whitespace-nowrap"
      >
        <SegCtl
          label={t("agentRuntime.sessionsSegmentLabel")}
          value={segment}
          onChange={(value) => {
            setSegment(value);
            narrow.backToList();
          }}
          options={[
            { value: "sessions", label: t("agentRuntime.sessionsSegmentSingle") },
            { value: "squads", label: t("agentRuntime.sessionsSegmentSquad") },
          ]}
        />
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
          <>
            {/* 状态词表实测 ~795px:容器 ≥1100px 时平铺(放不下时换行,不横向滚动);
                更窄时平铺 + 检索放不进一行,收纳进下拉让工具条一行放下(标准 §1.9②)。 */}
            <span
              role="group"
              aria-label={t("agentRuntime.sessionsStatusLabel")}
              data-testid="sessions-status-filter"
              className="hidden min-w-24 gap-1 py-1 @min-[1100px]:inline-flex [&>button]:shrink-0"
            >
              {sessionStatusFilterWords.map((word) => (
                <StatusFilterButton
                  key={word}
                  word={word}
                  pressed={statusFilter.has(word)}
                  onToggle={toggleStatusFilter}
                  testId={`sessions-status-${word}`}
                />
              ))}
            </span>
            <Popover
              label={t("agentRuntime.sessionsStatusLabel")}
              testId="sessions-status-filter-menu"
              panelClassName="w-60"
              triggerClassName={
                "@min-[1100px]:hidden inline-flex h-7 items-center gap-1.5 rounded-xs border px-3 ui-meta " +
                (status.length === 0
                  ? "border-border bg-text/5 text-text-muted hover:bg-surface"
                  : "border-accent/40 bg-accent/15 font-semibold text-accent")
              }
              trigger={
                <>
                  {t("agentRuntime.sessionsStatusLabel")}
                  {status.length > 0 ? ` · ${status.length}` : ""}
                  <span aria-hidden>▾</span>
                </>
              }
            >
              {() =>
                sessionStatusFilterWords.map((word) => (
                  <StatusFilterButton
                    key={word}
                    word={word}
                    pressed={statusFilter.has(word)}
                    onToggle={toggleStatusFilter}
                    testId={`sessions-status-menu-${word}`}
                    className="mb-1 w-full text-left"
                  />
                ))
              }
            </Popover>
          </>
        )}
        <input
          type="search"
          data-testid="sessions-search"
          aria-label={t("agentRuntime.sessionsSearchLabel")}
          placeholder={t("agentRuntime.sessionsSearchPlaceholder")}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className={
            "ml-auto min-w-36 flex-1 rounded-xs border border-border bg-surface-raised px-3 py-1.5 ui-meta text-text " +
            "outline-none placeholder:text-text-faint focus:border-border-strong"
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
        <CatalogSplit detailOpen={narrow.detailOpen} className="px-2 pb-2">
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
          <main
            data-testid="sessions-detail"
            data-pane="detail"
            className="min-w-0 flex-1 overflow-y-auto px-5 pt-4 pb-6"
          >
            <CatalogBackButton testId="sessions-back-to-list" onBack={narrow.backToList} />
            {selectedSessionId === null ? (
              <Empty>{t(workspace.groups.isPending ? "agentRuntime.loading" : "agentRuntime.noSessions")}</Empty>
            ) : (
              <>
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
                  taskTitles={taskTitles}
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
              </>
            )}
          </main>
          {inspector && selectedRow !== null && (
            <SessionInspector
              row={selectedRow}
              siblings={siblings}
              squadNames={squadNames}
              onSelectSession={(runtimeSessionId) => onSelectEntity(`session/${runtimeSessionId}`)}
              onOpenTask={onOpenTask}
              onSelectEntity={onSelectEntity}
            />
          )}
        </CatalogSplit>
      ) : (
        <CatalogSplit detailOpen={narrow.detailOpen} className="px-2 pb-2">
          <SquadRunList
            runs={runs}
            truncated={workspace.squadRuns.data?.truncated ?? false}
            totalRuns={runTotals.runs}
            squadNames={squadNames}
            query={debouncedSearch}
            range={rangeLabel[rangeBySegment.squads]}
            selectedId={selectedSquadRun?.squadRunId ?? null}
            onSelectRun={(squadRunId) => {
              setSelectedSquadRunId(squadRunId);
              narrow.openDetail();
            }}
          />
          <main data-pane="detail" className="min-w-0 flex-1 overflow-y-auto">
            <CatalogBackButton testId="sessions-back-to-list" onBack={narrow.backToList} />
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
        </CatalogSplit>
      )}
    </section>
  );
}

/** 状态筛选钮:平铺与下拉共用一份;集合语义(空集 = 不筛)。 */
function StatusFilterButton({
  word,
  pressed,
  onToggle,
  testId,
  className = "",
}: {
  readonly word: SessionStatus;
  readonly pressed: boolean;
  readonly onToggle: (word: SessionStatus) => void;
  readonly testId: string;
  readonly className?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={pressed}
      onClick={() => onToggle(word)}
      className={`h-7 whitespace-nowrap rounded-xs border px-3 ui-meta ${className} ${
        pressed
          ? "border-accent/40 bg-accent/15 font-semibold text-accent"
          : "border-border bg-text/5 text-text-muted hover:bg-surface"
      }`}
    >
      {t(sessionStatusKey[word] as never)}
    </button>
  );
}

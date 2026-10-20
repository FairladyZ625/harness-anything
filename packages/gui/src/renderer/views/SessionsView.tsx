import { SegCtl } from "../components/primitives/SegCtl.tsx";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { isAvailableSquadRunSummary } from "@harness-anything/daemon/protocol";
import { Popover } from "../components/Popover.tsx";
import { agentEntityClient, isAvailableSquadEntityRow } from "../agent-entity-client.ts";
import { agentRuntimeClient, runtimeQueryKeys } from "../agent-runtime-client.ts";
import { harnessClient } from "../api-client.ts";
import { t, type MessageKey } from "../i18n/index.tsx";
import { workspaceTitleIndex } from "../model/workspace-readable.ts";
import { useTasksQuery } from "../task-data.ts";
import { Empty } from "../components/primitives/Empty.tsx";
import { CatalogBackButton, CatalogSplit, useCatalogDetailPane } from "../components/primitives/CatalogSplit.tsx";
import { PageHeader } from "../components/primitives/PageHeader.tsx";
import { Button } from "../components/primitives/Button.tsx";
import {
  runtimeSelectionFromRef,
  useRelatedDispatches,
  useSessionsWorkspace,
  useSquadRunDetail,
} from "../components/runtime/useRuntimeWorkspace.ts";
import {
  SessionGroupList,
  type DecisionGroupRows,
  type SessionGroupRows,
} from "../components/sessions/SessionGroupList.tsx";
import { DecisionReviewSessionCard } from "../components/sessions/DecisionReviewSessionCard.tsx";
import { decisionReviewRounds } from "../model/decision-review.ts";
import { decisionSessionsLocation } from "../navigation/decisionReviewRoutes.ts";
import { adaptDecisionRows, triadicQueryKeys } from "../triadic-data.ts";
import { SquadRunList } from "../components/sessions/SquadRunList.tsx";
import { SquadRunDetail } from "../components/sessions/SquadRunDetail.tsx";
import { SessionInspector } from "../components/sessions/SessionInspector.tsx";
import { SessionsPanel } from "../components/runtime/SessionsPanel.tsx";
import {
  sortBySmartAttention,
  computePromptCacheTtlState,
  type SmartAttentionSignal,
} from "../model/smart-attention.ts";
import { useOverviewSessionTouches } from "../overview-data.ts";
import { useAgendaQuery } from "../agenda-data.ts";
import type { RelationEdge } from "../model/types.ts";
import type { TaskDispatchProjectionRow } from "../../api/renderer-dto.ts";
import {
  epochMsOf,
  needsYouRefs,
  sessionGroupNeedsYou,
  sessionDecisionRefs,
  sessionOrphans,
  sessionRounds,
  sessionRoundsByTask,
  sessionStatusFilterWords,
  sessionStatusKey,
  sessionWorkGroups,
  sessionWorkKeyForTask,
  type SessionDrillTarget,
  type SessionGroup,
  type SessionGroupBy,
  type SessionOrphan,
  type SessionRound,
  type SessionStatus,
} from "../sessions-model.ts";
import { NO_WORKS, type WorkIndex } from "../model/work-collections.ts";

/**
 * 会话页(设计稿 §2–§5;标准 §2.5 v2 与 Agent 页同构:左列表、右常驻详情,不用抽屉):顶层两大段——单会话(默认,按 Task 分组)与小队编排
 * (一次 `ha squad run` 一个编排单元)。分组、范围与检索都在 daemon 侧完成
 * (sessionGroups / squad.runs.list),前端一次 RPC 拿组,不再翻 overview 分页、不再
 * 前端 join 派工台账。选择可寻址:session/<id>、tasksessions/<taskId>,导航回撤
 * 原路返回。
 *
 * 本体即功能体(task_48fe291624e06a2e9ad9496c81 起与工作台会话面板共用):页面用
 * 默认 renderHeader 装 PageHeader(标题 + 计数结论 + 检查器开关),工作台面板传
 * 空渲染——面板标签即标题,计数行不进面板。
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
/** 多计数句里每个计数各自选单/复数文案;整句语序仍由 i18n 目录持有。 */
const countLabel = (count: number, oneKey: MessageKey, manyKey: MessageKey): string =>
  t(count === 1 ? oneKey : manyKey, { count });

export interface SessionsViewProps {
  readonly repoId: string;
  readonly relations: readonly RelationEdge[];
  readonly focusedEntityRef: string | null;
  readonly onSelectEntity: (ref: string) => void;
  readonly onOpenTask: (taskId: string) => void;
  /** 窄容器返回键:全局导航弹栈(App 注入,与顶栏后退/侧键同一条路径)。 */
  readonly onBack: () => void;
  /** App 层常驻的工作索引(dec_5F7E74F1):「工作」层只归桶,不另起读。 */
  readonly works?: WorkIndex;
}

/** 页头插槽:计数结论与主动作由工作区实况派生,页面/面板各自决定要不要装。 */
export interface SessionsHeaderSlot {
  readonly countsNote: ReactNode;
  readonly headerActions: ReactNode;
}

function renderSessionsPageHeader({ countsNote, headerActions }: SessionsHeaderSlot) {
  return <PageHeader title={t("agentRuntime.sessionsTitle")} note={countsNote} actions={headerActions} />;
}

export function SessionsView({
  repoId,
  relations,
  focusedEntityRef,
  onSelectEntity,
  onOpenTask,
  onBack,
  works = NO_WORKS,
  renderHeader = renderSessionsPageHeader,
}: SessionsViewProps & {
  /** 页面组合的页头渲染;工作台面板传空渲染(面板标签即标题)。 */
  readonly renderHeader?: (slot: SessionsHeaderSlot) => ReactNode;
}) {
  const [segment, setSegment] = useState<Segment>("sessions");
  // 「工作」是默认层,但只在索引已答且确有工作时:空仓/未加载时退回 Task,不把
  // 全部任务塞进一个「散件」桶当首屏。用户在索引到达前手动改过分组就不覆盖。
  // 工作索引已在 App 层缓存时直接以工作开局,避免「先闪一帧 Task 再切工作」;
  // 首次加载(索引未答)仍从 Task 起,由下面的 effect 在索引到达后补切。
  const [groupBy, setGroupBy] = useState<SessionGroupBy>(() => (works.ready && works.hasWorks ? "work" : "task"));
  const groupingPicked = useRef(false);
  const workDefaultApplied = useRef(false);
  useEffect(() => {
    if (workDefaultApplied.current || groupingPicked.current || !works.ready) return;
    workDefaultApplied.current = true;
    // 深链(tasksessions/session/decisionsessions)必须原地展开它指向的组,不能被默认
    // 工作层盖掉;无深链时才把首屏换成工作。
    if (focusedEntityRef !== null) return;
    if (works.hasWorks) setGroupBy("work");
  }, [focusedEntityRef, works.ready, works.hasWorks]);
  const [rangeBySegment, setRangeBySegment] = useState<Readonly<Record<Segment, Range>>>(DEFAULT_RANGE);
  const range = rangeBySegment[segment],
    setRange = (value: Range) => setRangeBySegment((current) => ({ ...current, [segment]: value }));
  const [search, setSearch] = useState("");
  // 状态筛选是集合:排障常要「失败或丢失」,而检索框的词之间是 AND,写不出这个。
  const [statusFilter, setStatusFilter] = useState<ReadonlySet<SessionStatus>>(new Set());
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [inspector, setInspector] = useState(true);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());
  const [workExpandedKeys, setWorkExpandedKeys] = useState<ReadonlySet<string>>(new Set());
  // 钻入不是路由(不打断当前台账切面):面包屑 + 返回留在列表顶部,点会话仍可深链。
  const [drill, setDrill] = useState<SessionDrillTarget | null>(null);
  const [sessionTaskScope, setSessionTaskScope] = useState<{
    readonly runtimeSessionId: string;
    readonly taskId: string;
  } | null>(null);
  const refSelection = runtimeSelectionFromRef(focusedEntityRef);
  const focusedSessionId = refSelection?.type === "session" ? refSelection.id : null;
  const taskRouteId = focusedEntityRef?.startsWith("tasksessions/")
    ? focusedEntityRef.slice("tasksessions/".length) || null
    : null;
  // 小队编排段的行选中落点(squadrun/<id>,推栈;点行与后退前进共用一条路径)。
  const squadRunRefId = focusedEntityRef?.startsWith("squadrun/") ? focusedEntityRef.slice("squadrun/".length) : null;
  // Decision 评审会话的落点(decisionsessions/<decisionId>[/<runtimeSessionId>]):按被评审
  // Decision 归组(daemon 按派工头 reviewTarget 分组),不从 session.taskId 猜 Decision。
  const decisionFocus = decisionSessionsLocation(focusedEntityRef);

  // 检索 150ms debounce(设计稿 §4):即时过滤,但 RPC 频率有界。
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 150);
    return () => window.clearTimeout(timer);
  }, [search]);

  // 深链落点:tasksessions/<taskId> 切单会话段、Task 分组并把读范围收窄到该
  // task;session/<id> 切单会话段,精确 read 返回后再展开其 task binding;
  // squadrun/<id> 切小队编排段并选中该 run。
  useEffect(() => {
    if (focusedEntityRef === null) {
      setSessionTaskScope(null);
      return;
    }
    if (focusedEntityRef.startsWith("squadrun/")) {
      setSegment("squads");
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

  // 窄容器(内容区 <720px,styles.css .catalog-split)的单列形态:点行进详情 = 推栈
  // 选中引用;全局后退/返回键弹回无引用条目即回列表。宽容器常驻双栏,该状态不参与
  // 显隐。机制与小组件在 primitives/CatalogSplit;focusKey 按段落取各自的选中引用。
  const narrow = useCatalogDetailPane(
    segment === "squads" ? squadRunRefId : (focusedSessionId ?? decisionFocus?.runtimeSessionId ?? null),
  );

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
  const groups = useMemo(() => workspace.groups.data?.groups ?? [], [workspace.groups.data]),
    totals = workspace.groups.data?.totals ?? { groups: 0, sessions: 0 },
    truncated = workspace.groups.data?.truncated ?? false;
  // 钻入复用 Agent/Squad 页现役的 useRelatedDispatches(同一条 sessionGroups 精确
  // 过滤 + 同一批 task.dispatches),不写第三份同形读。
  const related = useRelatedDispatches(repoId, drill);
  const runs = useMemo(() => workspace.squadRuns.data?.runs ?? [], [workspace.squadRuns.data]),
    runTotals = workspace.squadRuns.data?.totals ?? { runs: 0 };

  // 检索单组命中时自动展开(设计稿 §7.1:命中 1 组 1 轮,组自动展开)。工作层还要
  // 展开该任务所属的工作,否则命中的组藏在收起的工作里。
  useEffect(() => {
    if (debouncedSearch === "" || groups.length !== 1 || groups[0]?.kind !== "task") return;
    if (groupBy !== "task" && groupBy !== "work") return;
    const [group] = groups;
    const key = group.key;
    setExpandedGroups((current) => (current.has(key) ? current : new Set([...current, key])));
    if (groupBy !== "work") return;
    const workKey = sessionWorkKeyForTask(works, group.taskId);
    if (workKey !== null)
      setWorkExpandedKeys((current) => (current.has(workKey) ? current : new Set([...current, workKey])));
  }, [debouncedSearch, groupBy, groups, works]);

  // 组展开行集:每个已展开任务组两次读(task.dispatches 全部轮次 + overview { taskId }
  // 绑定会话做孤儿判定)。数据在页级持有,组列表、主区与 inspector 共用缓存键。
  // 钻入时轮次已随 useRelatedDispatches 的批量读返回,不再发这两组读。
  const expandedTasks = useMemo(
    () =>
      drill === null
        ? groups.filter(
            (group): group is SessionGroup & { readonly taskId: string } =>
              group.kind === "task" && group.taskId !== undefined && expandedGroups.has(group.key),
          )
        : [],
    [drill, groups, expandedGroups],
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

  // 钻入的轮次来自同一批派工行:按任务组分好即挂到组体,点开组头不再二次读。
  const drillRowsByGroup = useMemo(() => {
    if (drill === null) return new Map<string, SessionGroupRows>();
    const rounds = sessionRoundsByTask(related.groups, related.dispatchRows),
      rows = new Map<string, SessionGroupRows>();
    for (const group of related.groups) {
      if (group.taskId === undefined) continue;
      rows.set(group.taskId, {
        rounds: rounds.get(group.taskId) ?? [],
        orphans: [],
        pending: related.pending,
        error: related.error,
      });
    }
    return rows;
  }, [drill, related.groups, related.dispatchRows, related.pending, related.error]);
  const displayedRowsByGroup = drill === null ? groupRows : drillRowsByGroup;

  // Decision 组:daemon 组行只带 decisionId,组头标题与展开行都取 Decision full 行(标题、
  // reviewDispatches),与决策池/详情共用同一缓存键;列表里有 Decision 组或落 Decision 会话深链时才读。
  const decisionGroupIds = useMemo(
    () =>
      (drill === null ? groups : related.groups).flatMap((group) =>
        group.kind === "decision" && group.decisionId !== undefined ? [group.decisionId] : [],
      ),
    [drill, groups, related.groups],
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
  const agenda = useAgendaQuery(repoId);
  const pendingDecisionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const d of agenda.data?.awaitingDecision ?? []) ids.add(d.decisionId);
    for (const d of agenda.data?.awaitingDecisionReview ?? []) ids.add(d.decisionId);
    for (const d of reviewedDecisions) {
      if (d.state === "proposed") ids.add(d.decisionId);
    }
    return [...ids];
  }, [agenda.data, reviewedDecisions]);

  const attentionRefs = useMemo(() => {
    const awaitingYou = agenda.data?.awaitingYou ?? [];
    const refs = new Set<string>(needsYouRefs(awaitingYou, pendingDecisionIds));
    for (const edge of relations) {
      if (edge.kind === "awaits" && edge.from) refs.add(edge.from);
    }
    return refs;
  }, [agenda.data?.awaitingYou, pendingDecisionIds, relations]);

  // 注意力排序与倒计时共用一根秒针:nowMs=0 会让 Done 新鲜度窗口永久成立
  // (0 - settledAt 恒小于窗口),旧完成组永远压在 Working 之上,排序必须用真实时钟。
  // 秒针 effect 在下方,只在确有缓存触达证据时才走(与 OverviewView 同口径)。
  const [nowMs, setNowMs] = useState(() => Date.now());

  const groupSignal = useCallback(
    (g: SessionGroup): SmartAttentionSignal => {
      const needsYou = sessionGroupNeedsYou(g, attentionRefs);
      const lastTurnActivityAt = epochMsOf(g.latestActivityAt);
      return {
        status: g.latestStatus,
        needsYou,
        lastTurnActivityAt,
        settledAt:
          g.latestStatus === "succeeded" || g.latestStatus === "failed" || g.latestStatus === "ended-indeterminate"
            ? lastTurnActivityAt
            : null,
      };
    },
    [attentionRefs],
  );

  // 钻入排序用 related.dispatchRows(dockRows 的原始行):它自带 dispatch 行的真实
  // endedAt 与字面量 status 词表,不需要 dockRows 上的收窄断言。口径与
  // sessionRoundAttention 相同(endedAt ?? startedAt)。
  const dispatchRowSignal = useCallback(
    (row: TaskDispatchProjectionRow): SmartAttentionSignal => ({
      status: row.status,
      needsYou: attentionRefs.has(`task/${row.taskId}`),
      lastTurnActivityAt: epochMsOf(row.endedAt) ?? epochMsOf(row.startedAt),
      settledAt: epochMsOf(row.endedAt),
    }),
    [attentionRefs],
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
    () => [...displayedRowsByGroup.values()].flatMap(({ rounds, orphans }) => [...rounds, ...orphans]),
    [displayedRowsByGroup],
  );
  const sortedGroups = useMemo(() => sortBySmartAttention(groups, groupSignal, nowMs), [groups, groupSignal, nowMs]);
  const sortedRelatedGroups = useMemo(
    () => sortBySmartAttention(related.groups, groupSignal, nowMs),
    [related.groups, groupSignal, nowMs],
  );
  const displayedGroups = drill === null ? sortedGroups : sortedRelatedGroups,
    displayedTruncated = drill === null ? truncated : related.truncated;
  const workGroups = useMemo(
    () => (groupBy === "work" && drill === null ? sessionWorkGroups(sortedGroups, works) : []),
    [groupBy, drill, sortedGroups, works],
  );

  const defaultSessionId =
      sortedGroups.find((group) => group.latestRound !== null)?.latestRound?.runtimeSessionId ?? null,
    // 钻入后先落该执行者「最新需要关注的会话」;若当前深链会话不在其列,不让右侧停
    // 在别的执行者上。派工行按五级注意力排序(dockRows 与其同源同序)。
    drillDefaultSessionId =
      sortBySmartAttention(related.dispatchRows, dispatchRowSignal, nowMs)[0]?.runtimeSessionId ?? null,
    focusedSessionVisible =
      focusedSessionId !== null &&
      (drill === null || related.dockRows.some((row) => row.runtimeSessionId === focusedSessionId)),
    selectedSessionId =
      decisionFocus?.runtimeSessionId ??
      (focusedSessionVisible ? focusedSessionId : null) ??
      (drill === null ? defaultSessionId : drillDefaultSessionId);

  const selectedSession = useQuery({
    queryKey: runtimeQueryKeys.session(repoId, selectedSessionId ?? ""),
    queryFn: () => agentRuntimeClient.session(repoId, selectedSessionId!),
    enabled: selectedSessionId !== null,
    staleTime: 4_000,
  });

  const touchSessionIds = useMemo(() => {
    const ids = new Set<string>();
    if (selectedSessionId) ids.add(selectedSessionId);
    const now = Date.now();
    for (const group of displayedGroups) {
      const at = epochMsOf(group.latestActivityAt);
      const isRecent = at !== null && now - at < 300_000;
      if (group.latestRound?.runtimeSessionId && (group.runningCount > 0 || isRecent)) {
        ids.add(group.latestRound.runtimeSessionId);
      }
    }
    for (const row of allRows) {
      // orphan 行没有派工收口时刻,只有 startedAt;round 行与 sessionRoundAttention 同口径。
      const at = (row.kind === "round" ? epochMsOf(row.endedAt) : null) ?? epochMsOf(row.startedAt);
      const isRecent = at !== null && now - at < 300_000;
      if (row.status === "running" || isRecent) {
        ids.add(row.runtimeSessionId);
      }
    }
    return [...ids];
  }, [selectedSessionId, displayedGroups, allRows]);

  const sessionTouches = useOverviewSessionTouches(repoId, touchSessionIds);
  const hasCacheTouches = useMemo(() => [...sessionTouches.values()].some((touch) => touch !== null), [sessionTouches]);
  useEffect(() => {
    if (!hasCacheTouches) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [hasCacheTouches]);

  const selectedTouch = selectedSessionId ? (sessionTouches.get(selectedSessionId) ?? null) : null;
  const selectedSessionTtl = useMemo(() => computePromptCacheTtlState(selectedTouch, nowMs), [selectedTouch, nowMs]);
  // 深链补展开只对该 session 焦点应用一次(G12 §1a):ref 记住已应用的
  // focusedSessionId,之后的组数据刷新/维度切换不再把 groupBy/range 压回深链值——
  // 用户切到 Squad/Agent/时间维度时不再被弹回 Task。
  const appliedFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (focusedSessionId === null) {
      appliedFocusRef.current = null;
      return;
    }
    // 钻入中点击会话只是选中右侧,不应把分组压回 Task、也不应把面包屑踢掉。
    if (drill !== null) {
      appliedFocusRef.current = focusedSessionId;
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
  }, [drill, focusedSessionId, groups, selectedSession.data, workspace.groups.data]);
  const selectedRow =
    selectedSessionId === null ? null : (allRows.find((row) => row.runtimeSessionId === selectedSessionId) ?? null);
  const selectedTaskId = selectedRow?.taskId ?? selectedSession.data?.session.associations[0]?.taskId ?? null;
  const selectedSessionNeedsYou = useMemo(() => {
    if (selectedSessionId === null) return false;
    if (selectedTaskId !== null && attentionRefs.has(`task/${selectedTaskId}`)) return true;
    if (decisionFocus?.decisionId != null && attentionRefs.has(`decision/${decisionFocus.decisionId}`)) return true;
    return false;
  }, [selectedSessionId, selectedTaskId, decisionFocus, attentionRefs]);
  const siblings =
    selectedRow === null
      ? []
      : allRows.filter(
          (row) => row.taskId === selectedRow.taskId && row.runtimeSessionId !== selectedRow.runtimeSessionId,
        );
  const liveCount = displayedGroups.reduce((total, group) => total + group.runningCount, 0);
  const availableRuns = runs.filter(isAvailableSquadRunSummary);
  const activeRunCount = availableRuns.filter(
    (run) => run.phase !== "converged" && run.phase !== "failed" && run.phase !== "cancelled",
  ).length;

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
  // 页内点选只换右侧详情:先记为已应用,聚焦 effect 就不会把分组压回 Task(那只给外部深链)。
  const selectSessionFromRail = useCallback(
    (runtimeSessionId: string) => {
      appliedFocusRef.current = runtimeSessionId;
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
  const toggleStatusFilter = useCallback((word: SessionStatus) => {
    setStatusFilter((current) => {
      const next = new Set(current);
      if (next.has(word)) next.delete(word);
      else next.add(word);
      return next;
    });
  }, []);
  const toggleWork = useCallback((key: string) => {
    setWorkExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  // 钻入:列表原地切到「该执行者的全部会话(按任务分组)」,不清导航栈;返回只清本地状态。
  const drillInto = useCallback((target: SessionDrillTarget) => {
    setDrill(target);
    setExpandedGroups(new Set());
  }, []);
  const backFromDrill = useCallback(() => setDrill(null), []);

  // 小队编排详情(G12 §2b/§2c):选中行(可寻址 squadrun/<id>)的 repo.squad.run.read,
  // 渲染 leader 轮次 → worker 派工链扇出树;只有显式点击行才读取详情(深链引用不在
  // 列表时 selectedSquadRun 为 null,回到空选中)。读面收敛在 useSquadRunDetail(与失效键同源)。
  const selectedSquadRun =
    squadRunRefId === null ? null : (availableRuns.find((run) => run.squadRunId === squadRunRefId) ?? null);
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
  // 页头插槽的实况件:计数结论句与检查器开关(页面装进 PageHeader,面板不装)。
  const countsNote = (
    <span data-testid="sessions-counts" className="truncate">
      {segment === "sessions"
        ? drill !== null
          ? t("agentRuntime.sessionsDrillSummary", {
              groups: countLabel(
                related.totals.groups,
                "agentRuntime.sessionsSummaryTaskGroup",
                "agentRuntime.sessionsSummaryTaskGroups",
              ),
              sessions: countLabel(
                related.totals.sessions,
                "agentRuntime.sessionsSessionCountOne",
                "agentRuntime.sessionsSessionCount",
              ),
              label: drill.label,
            })
          : (groupBy === "work"
              ? t("agentRuntime.sessionsWorkSummary", {
                  range: rangeLabel[range],
                  works: countLabel(
                    workGroups.length,
                    "agentRuntime.sessionsSummaryWork",
                    "agentRuntime.sessionsSummaryWorks",
                  ),
                  groups: countLabel(
                    totals.groups,
                    "agentRuntime.sessionsSummaryTaskGroup",
                    "agentRuntime.sessionsSummaryTaskGroups",
                  ),
                  sessions: countLabel(
                    totals.sessions,
                    "agentRuntime.sessionsSessionCountOne",
                    "agentRuntime.sessionsSessionCount",
                  ),
                })
              : t("agentRuntime.sessionsSummary", {
                  range: rangeLabel[range],
                  groups: countLabel(
                    totals.groups,
                    "agentRuntime.sessionsSummaryGroup",
                    "agentRuntime.sessionsSummaryGroups",
                  ),
                  sessions: countLabel(
                    totals.sessions,
                    "agentRuntime.sessionsSessionCountOne",
                    "agentRuntime.sessionsSessionCount",
                  ),
                })) +
            // 计数是 daemon 按过滤后的集合算的,所以筛选生效时把它说出来——
            // 否则用户读到的是「会话消失了」而不是「这是筛后的数」。
            (status.length === 0
              ? ""
              : t("agentRuntime.sessionsStatusFilterNote", {
                  statuses: status.map((word) => t(sessionStatusKey[word] as never)).join(" / "),
                })) +
            " · " +
            t("agentRuntime.liveSessions", { count: liveCount })
        : t(runTotals.runs === 1 ? "agentRuntime.squadRunsCountOne" : "agentRuntime.squadRunsCounts", {
            range: rangeLabel[range],
            runs: runTotals.runs,
          }) +
          " · " +
          t("agentRuntime.squadRunsActive", { count: activeRunCount })}
    </span>
  );
  const drillHeader =
    drill === null ? undefined : (
      <div data-testid="sessions-drill-breadcrumb" className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          data-testid="sessions-drill-back"
          onClick={backFromDrill}
          className="shrink-0 rounded border border-border px-2 py-0.5 ui-micro text-text-muted hover:border-accent hover:text-accent"
        >
          ← {t("agentRuntime.sessionsDrillBack")}
        </button>
        <span className="min-w-0 truncate ui-meta text-text-muted">
          {t("agentRuntime.sessionsDrillAll")} <span aria-hidden>›</span> <b className="text-text">{drill.label}</b>
        </span>
      </div>
    );
  const headerActions =
    segment === "sessions" && selectedSessionId !== null ? (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setInspector(!inspector)}
        tip={t("agentRuntime.toggleInspector")}
      >
        ▐
      </Button>
    ) : undefined;
  return (
    <section data-testid="sessions-view" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {renderHeader !== undefined ? renderHeader({ countsNote, headerActions }) : null}
      <div
        data-testid="sessions-toolbar"
        className="flex min-h-12 shrink-0 flex-wrap items-center gap-2.5 px-5 py-2 @container [&>span[role=group]]:shrink-0 [&_button]:whitespace-nowrap"
      >
        <SegCtl
          label={t("agentRuntime.sessionsSegmentLabel")}
          value={segment}
          onChange={(value) => {
            setSegment(value);
            if (value === "squads") setDrill(null);
          }}
          options={[
            { value: "sessions", label: t("agentRuntime.sessionsSegmentSingle"), testId: "sessions-segment-sessions" },
            { value: "squads", label: t("agentRuntime.sessionsSegmentSquad"), testId: "sessions-segment-squads" },
          ]}
        />
        {segment === "sessions" && (
          <SegCtl
            label={t("agentRuntime.sessionsGroupByLabel")}
            value={groupBy}
            onChange={(value) => {
              groupingPicked.current = true;
              setGroupBy(value);
              setDrill(null);
            }}
            options={[
              { value: "work", label: t("agentRuntime.sessionsGroupWork"), testId: "sessions-group-work" },
              { value: "task", label: t("agentRuntime.sessionsGroupTask"), testId: "sessions-group-task" },
              { value: "agent", label: t("agentRuntime.sessionsGroupAgent"), testId: "sessions-group-agent" },
              { value: "squad", label: t("agentRuntime.sessionsGroupSquad"), testId: "sessions-group-squad" },
              { value: "day", label: t("agentRuntime.sessionsGroupDay"), testId: "sessions-group-day" },
            ]}
          />
        )}
        {/* 钻入是“该执行者的全部会话”:范围/状态/检索都不作用于这条读,收起来而不是
            留一个改了没反应的控件。 */}
        {drill === null && (
          <SegCtl
            label={t("agentRuntime.sessionsRangeLabel")}
            value={range}
            onChange={(value) => setRange(value)}
            options={(Object.keys(RANGE_SPAN) as Range[]).map((value) => ({
              value,
              label: rangeLabel[value],
              testId: `sessions-range-${value}`,
            }))}
          />
        )}
        {segment === "sessions" && drill === null && (
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
        {drill === null && (
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
        )}
      </div>
      {drill !== null && related.error !== null && (
        <p
          role="alert"
          data-testid="sessions-drill-error"
          className="shrink-0 border-b border-border bg-status-blocked/10 px-3.5 py-1.5 font-mono ui-micro text-status-blocked"
        >
          {t("agentRuntime.readFailed", { error: related.error })}
        </p>
      )}
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
            pending={drill === null ? workspace.groups.isPending : related.pending}
            groups={displayedGroups}
            truncated={displayedTruncated}
            onLoadMore={drill === null || !related.hasMore ? undefined : related.loadMore}
            expandedKeys={expandedGroups}
            rowsByGroup={displayedRowsByGroup}
            decisionRowsByGroup={decisionGroupRows}
            selectedId={selectedSessionId}
            query={drill === null ? debouncedSearch : ""}
            decisionRefsFor={groupDecisionRefsFor}
            onSelectSession={selectSessionFromRail}
            onToggleGroup={toggleGroup}
            onOpenTask={onOpenTask}
            onSelectEntity={onSelectEntity}
            onDrill={drillInto}
            workGroups={groupBy === "work" && drill === null ? workGroups : undefined}
            workExpandedKeys={workExpandedKeys}
            onToggleWork={toggleWork}
            railHeader={drillHeader}
            sessionTouches={sessionTouches}
            attentionRefs={attentionRefs}
            nowMs={nowMs}
          />
          <main
            data-testid="sessions-detail"
            data-pane="detail"
            className="min-w-0 flex-1 overflow-y-auto px-5 pt-4 pb-6"
          >
            <CatalogBackButton testId="sessions-back-to-list" onBack={onBack} />
            {selectedSessionId === null ? (
              <Empty>
                {t(
                  (drill === null ? workspace.groups.isPending : related.pending)
                    ? "agentRuntime.loading"
                    : "agentRuntime.noSessions",
                )}
              </Empty>
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
                  cacheTtl={selectedSessionTtl}
                  needsYou={selectedSessionNeedsYou}
                />
              </>
            )}
          </main>
          {inspector && selectedRow !== null && (
            <SessionInspector
              row={selectedRow}
              siblings={siblings}
              squadNames={squadNames}
              onSelectSession={selectSessionFromRail}
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
            onSelectRun={(squadRunId) => onSelectEntity(`squadrun/${squadRunId}`)}
          />
          <main data-pane="detail" className="min-w-0 flex-1 overflow-y-auto">
            <CatalogBackButton testId="sessions-back-to-list" onBack={onBack} />
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

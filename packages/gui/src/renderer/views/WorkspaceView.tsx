import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { TabPanel } from "../components/primitives/EntryBoundary.tsx";
import { SegBar } from "../components/primitives/SegBar";
import { Tabs } from "../components/primitives/Tabs";
import { TaskPreviewDrawer } from "../components/TaskPreviewDrawer.tsx";
import { PinButton } from "../components/PinButton.tsx";
import type { WorkspaceScopeRead } from "../../api/renderer-dto.ts";
import type { DecisionRow, FactRef, RelationEdge, SnapshotStatus, TaskRow } from "../model/types.ts";
import { deriveAttestationLanes, type AttestationPoolLanes } from "../model/attestation-pool.ts";
import type { TaskMutationFeedback } from "../task-actions.ts";
import { useTaskDocumentQuery } from "../task-data.ts";
import { cadenceEventOf } from "../model/cadence.ts";
import { workDecisionsOf, workspaceEvidenceOf } from "../model/workspace-evidence.ts";
import { workspaceTitleIndex } from "../model/workspace-readable.ts";
import { noAgentRunning, workDayGroups, workspaceGoalLine, workSubgroups } from "../model/workspace-narrative.ts";
import { dayKeyOf, formatDayKeyLabel, formatRelative, formatTime } from "../model/time.ts";
import { t } from "../i18n/index.tsx";
import { WorkDayList, WorkOverview } from "./workspace/WorkOverview.tsx";
import { WorkTasksTab, type WorkLeafRow } from "./workspace/WorkTasksTab.tsx";
import { waitingReason } from "./workspace/entry-lines.tsx";
import { WorkDecisionsTab } from "./workspace/WorkDecisionsTab.tsx";
import { WorkGraphTab } from "./workspace/WorkGraphTab.tsx";
import { WorkInspectTab } from "./workspace/WorkInspectTab.tsx";

/**
 * 工作详情页(原型 v2,dec_AF44708E8F70F04E59FF751F9C/CH1):顶部身份 + 一行目标 +
 * 状态分段进度 + 标签栏(概况/任务/进展/决策与事实/检修) + 页内搜索;概况是与全局
 * 总览同一套的区域板(标准 §2.1),右列时间线;实体细节进右侧抽屉;原始事件流只在检修页。
 */

type WorkspaceTab = "overview" | "tasks" | "progress" | "decisions" | "graph" | "inspect" | "root";

export interface WorkspaceViewProps {
  readonly scope: WorkspaceScopeRead;
  readonly repoId?: string;
  readonly projectName: string;
  /** 行点击进抽屉;抽屉里的「打开完整详情」仍走这里(工作根由共享路由落回本页)。 */
  readonly onOpenTask: (taskId: string) => void;
  readonly tasks?: readonly TaskRow[];
  readonly decisions?: readonly DecisionRow[];
  readonly facts?: readonly FactRef[];
  readonly relations?: readonly RelationEdge[];
  readonly onNavigateEntity?: (ref: string) => void;
  /** 图抽屉与任务抽屉共用的置顶开关。 */
  readonly onSetTaskPin?: (task: TaskRow, pinned: boolean) => void;
  readonly onAttest?: (task: Pick<TaskRow, "taskId">, gateId: string, mode: "approve" | "override") => void;
  readonly onConsent?: (task: TaskRow, reviewId: string) => void;
  readonly onAdjudicate?: (task: TaskRow, decision: "forward" | "return", reason: string, reviewId?: string) => void;
  readonly feedback?: (taskId: string) => TaskMutationFeedback | undefined;
  readonly onLoadMore?: () => void;
  readonly loadingMore?: boolean;
  /** 根任务即工作:根任务自己的详情是本页一个分区。 */
  readonly renderRootTask?: (onBack: () => void) => ReactNode;
}

interface MemberRow {
  readonly taskId: string;
  readonly title: string;
  readonly status: SnapshotStatus;
  readonly pinned: boolean;
  readonly at: string;
  readonly parentTaskId: string | null;
  readonly row: TaskRow | null;
}

export function WorkspaceView({
  scope,
  repoId = "unselected",
  projectName,
  onOpenTask,
  tasks = [],
  decisions = [],
  facts = [],
  relations = [],
  onNavigateEntity,
  onSetTaskPin,
  onAttest,
  onConsent,
  onAdjudicate,
  feedback,
  onLoadMore,
  loadingMore = false,
  renderRootTask,
}: WorkspaceViewProps) {
  const [tab, setTab] = useState<WorkspaceTab>("overview");
  const [statusFilter, setStatusFilter] = useState("");
  const [groupFilter, setGroupFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [drawerTaskId, setDrawerTaskId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // 页内指向根任务的入口切到根任务分区,不离开工作页。
  const rootRef = `task/${scope.root.taskId}`;
  const openTask = (taskId: string) => {
    if (renderRootTask !== undefined && taskId === scope.root.taskId) {
      setTab("root");
      return;
    }
    // 抽屉吃完整 TaskRow;行还没投影到(读面未落地)就退到任务详情页。
    if (tasks.some(({ taskId: id }) => id === taskId)) setDrawerTaskId(taskId);
    else onOpenTask(taskId);
  };
  const openFullDetail = (taskId: string) =>
    renderRootTask !== undefined && taskId === scope.root.taskId ? setTab("root") : onOpenTask(taskId);
  const navigateEntity = (ref: string) =>
    renderRootTask !== undefined && ref === rootRef ? setTab("root") : onNavigateEntity?.(ref);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/") return;
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.tagName === "SELECT" ||
          active.isContentEditable)
      )
        return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const nowIso = useMemo(() => new Date().toISOString(), []),
    agoOf = useMemo(() => (iso: string) => formatRelative(iso, { now: nowIso }), [nowIso]),
    dateKeyOf = useMemo(() => (iso: string) => dayKeyOf(iso), []),
    todayKey = dateKeyOf(nowIso),
    yesterdayKey = dateKeyOf(new Date(Date.parse(nowIso) - 24 * 3_600_000).toISOString()),
    dayLabelOf = (dateKey: string) =>
      dateKey === todayKey
        ? t("views.workspace.progress.today")
        : dateKey === yesterdayKey
          ? t("views.workspace.progress.yesterday")
          : formatDayKeyLabel(dateKey);

  const rootRow = tasks.find(({ taskId }) => taskId === scope.root.taskId);
  const members = useMemo(() => new Set(scope.memberTaskIds), [scope.memberTaskIds]),
    scopedTasks = useMemo(() => tasks.filter(({ taskId }) => members.has(taskId)), [tasks, members]),
    groupIds = useMemo(() => new Set(scope.groups.map(({ taskId }) => taskId)), [scope.groups]);

  // 成员行:TaskRow 优先(有 lease/execution 投影),scope 行补缺(读面未落地时);
  // 父链两边都可能知道,TaskRow 没写就用 scope 行的。
  const memberRows = useMemo(() => {
    const rows = new Map<string, MemberRow>();
    for (const row of [...scope.groups, ...scope.tasks])
      rows.set(row.taskId, {
        taskId: row.taskId,
        title: row.title,
        status: row.status,
        pinned: row.pinned,
        at: row.updatedAt,
        parentTaskId: row.parentTaskId,
        row: null,
      });
    for (const task of scopedTasks) {
      const existing = rows.get(task.taskId);
      rows.set(task.taskId, {
        taskId: task.taskId,
        title: task.title,
        status: task.coordinationStatus,
        pinned: task.pinned === true,
        at: task.lastKnownAt,
        parentTaskId: task.parentTaskId ?? existing?.parentTaskId ?? null,
        row: task,
      });
    }
    return rows;
  }, [scope.groups, scope.tasks, scopedTasks]);

  const { subgroups, leafRows } = useMemo(() => {
    const leaves = [...memberRows.values()].filter(
      ({ taskId }) => taskId !== scope.root.taskId && !groupIds.has(taskId),
    );
    const groups = workSubgroups({
      rootTaskId: scope.root.taskId,
      groups: scope.groups.map(({ taskId, parentTaskId, title }) => ({ taskId, parentTaskId, title })),
      leaves: leaves.map(({ taskId, parentTaskId, status }) => ({ taskId, parentTaskId, status })),
    });
    const groupKeyByTask = new Map(
      groups.flatMap((group) => group.memberTaskIds.map((taskId) => [taskId, group.key] as const)),
    );
    // 卡住本任务的任务可能在工作之外:标题先查成员行,再查全仓任务切面。
    const blockerTitleOf = (taskId: string) =>
      memberRows.get(taskId)?.title ?? tasks.find((task) => task.taskId === taskId)?.title;
    return {
      subgroups: groups,
      leafRows: leaves.map<WorkLeafRow>((leaf) => ({
        taskId: leaf.taskId,
        title: leaf.title,
        status: leaf.status,
        pinned: leaf.pinned,
        at: leaf.at,
        groupKey: groupKeyByTask.get(leaf.taskId) ?? "_loose",
        executor: leaf.row?.leaseHolder ?? undefined,
        waiting: waitingReason(leaf.row?.blockers, blockerTitleOf),
      })),
    };
  }, [memberRows, groupIds, scope.root.taskId, scope.groups, tasks]);

  const leafCounts = useMemo(() => {
    const counts: Partial<Record<SnapshotStatus, number>> = {};
    for (const { status } of leafRows) counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, [leafRows]);

  const titles = useMemo(
    () =>
      workspaceTitleIndex({
        tasks: [scope.root, ...scope.ancestors, ...scope.groups, ...scope.tasks, ...tasks],
        facts,
        decisions,
      }),
    [scope, tasks, facts, decisions],
  );

  const submitted = useMemo(
    () =>
      scopedTasks
        .filter(({ taskId, coordinationStatus }) => coordinationStatus === "submitted" && !groupIds.has(taskId))
        .sort((left, right) => left.lastKnownAt.localeCompare(right.lastKnownAt)),
    [scopedTasks, groupIds],
  );
  const lanes: AttestationPoolLanes = useMemo(() => deriveAttestationLanes(scopedTasks), [scopedTasks]);
  const heroCount = submitted.length + lanes.gates.length + lanes.breakGlass.length + lanes.consents.length;
  const stalled = useMemo(
    () =>
      scopedTasks
        .filter(({ taskId }) => !groupIds.has(taskId))
        .filter(noAgentRunning)
        .sort((left, right) => right.lastKnownAt.localeCompare(left.lastKnownAt)),
    [scopedTasks, groupIds],
  );

  const events = useMemo(() => scope.eventSummaries.map(cadenceEventOf), [scope.eventSummaries]),
    evidence = useMemo(
      () =>
        workspaceEvidenceOf({
          memberTaskIds: [scope.root.taskId, ...scope.memberTaskIds],
          events,
          decisions,
          facts,
          relations,
        }),
      [scope, events, decisions, facts, relations],
    ),
    dayGroups = useMemo(() => workDayGroups({ events, titles, dateKeyOf }), [events, titles, dateKeyOf]),
    workDecisions = useMemo(
      () =>
        workDecisionsOf({
          memberTaskIds: [scope.root.taskId, ...scope.memberTaskIds],
          decisions,
          relations,
        }),
      [scope, decisions, relations],
    );

  const drawerTask = drawerTaskId === null ? null : (tasks.find(({ taskId }) => taskId === drawerTaskId) ?? null),
    effectiveTotal = Math.max(1, scope.scope.executableLeafCount),
    lastActivityAt = events.at(-1)?.at ?? scope.root.updatedAt,
    tabs = [
      {
        key: "overview" as const,
        label: t("views.workspace.tab.overview"),
        ...(heroCount > 0 ? { hint: t("views.workspace.tab.awaitingHint", { count: heroCount }) } : {}),
      },
      { key: "tasks" as const, label: t("views.workspace.tab.tasks"), count: scope.scope.executableLeafCount },
      { key: "progress" as const, label: t("views.workspace.tab.progress") },
      { key: "decisions" as const, label: t("views.workspace.tab.decisions") },
      { key: "graph" as const, label: t("views.workspace.tab.graph") },
      { key: "inspect" as const, label: t("views.workspace.tab.inspect") },
      ...(renderRootTask !== undefined ? [{ key: "root" as const, label: t("views.workspace.rootTaskTab") }] : []),
    ];

  return (
    <div data-testid="workspace-view" className="flex h-full min-h-0 flex-1 flex-col">
      <header className="flex-none px-5 pt-3.5 md:px-7">
        <nav className="text-text-muted ui-meta" aria-label="工作范围">
          {[projectName, ...scope.ancestors.map(({ title }) => title), scope.root.title].join(" / ")}
        </nav>
        <div className="mt-0.5 flex items-start gap-3">
          <h1 className="min-w-0 flex-1 text-[19px] font-semibold leading-snug text-text">{scope.root.title}</h1>
          {rootRow !== undefined && onSetTaskPin !== undefined ? (
            <PinButton
              testId="workspace-root-pin"
              pinned={rootRow.pinned === true}
              onClick={() => onSetTaskPin(rootRow, rootRow.pinned !== true)}
            />
          ) : null}
        </div>
        {repoId !== "unselected" && scope.goalMaterial !== null ? (
          <WorkMission repoId={repoId} taskId={scope.goalMaterial.taskId} path={scope.goalMaterial.path} />
        ) : null}
        <div className="mt-2.5 flex items-center gap-3.5">
          <SegBar
            counts={{
              done: scope.counts.done,
              active: scope.counts.executing,
              submitted: scope.counts.pending,
              blocked: scope.counts.blocked,
              planned: scope.counts.planned,
              cancelled: scope.counts.cancelled,
            }}
            className="h-[5px] max-w-[520px] flex-1"
          />
          <span className="whitespace-nowrap font-mono text-text-muted ui-meta">
            <b className="text-text">{scope.counts.done}</b>
            {t("views.workspace.progressNumbers", {
              done: "",
              total: scope.scope.executableLeafCount,
              percent: Math.round((scope.counts.done / effectiveTotal) * 100),
            })}
            {" · "}
            {t("views.workspace.lastActivity", { ago: agoOf(lastActivityAt) })}
          </span>
        </div>
        <div className="mt-2 flex items-end gap-4">
          <div className="min-w-0 flex-1">
            <Tabs ariaLabel="工作分区" idPrefix="workspace" value={tab} onChange={setTab} tabs={tabs} />
          </div>
          <input
            ref={searchRef}
            type="search"
            data-testid="workspace-search"
            value={query}
            placeholder={t("views.workspace.tasks.search")}
            onChange={(event) => {
              const next = event.target.value;
              setQuery(next);
              // 任务页与「决策与事实」页都吃页内搜索;搜索时停在原页,其余页跳去任务页。
              if (next.trim() !== "")
                setTab((current) => (current === "tasks" || current === "decisions" ? current : "tasks"));
            }}
            className="mb-1.5 min-w-0 flex-1 rounded-xs border border-border bg-surface-raised px-3 py-1.5 text-text ui-meta outline-none placeholder:text-text-faint focus:border-border-strong md:w-[260px] md:flex-none"
          />
        </div>
      </header>

      <div className="@container min-h-0 flex-1 overflow-y-auto">
        {/* TabPanel 原语(#3163):role/aria 配对 + 页签切换的轻量入场动效,不各写一套。
            概况是一屏的区域板:容器 ≥900px 时面板占满可视高度,区域在自己内部滚动;
            本地图与根任务是工具型/详情面板,同样铺满可视高度、面板内滚动(原则 9①);
            其余页签是随内容往下排的文档型版式。 */}
        <TabPanel
          idPrefix="workspace"
          value={tab}
          className={
            tab === "overview"
              ? "flex flex-col gap-3 px-5 pb-3 pt-4 md:px-7 @[900px]:h-full"
              : tab === "graph" || tab === "root"
                ? "flex h-full min-h-0 flex-col px-5 pb-4 pt-4 md:px-7"
                : "grid grid-cols-1 gap-9 px-5 pb-16 pt-4 md:px-7"
          }
        >
          {(scope.status === "pending" || scope.warnings.length > 0) && (
            <div className="rounded-xs border border-warning/50 bg-warning/10 p-3 text-text ui-body">
              {t("views.workspace.pendingCut", { watermark: scope.watermark, sourceRevision: scope.sourceRevision })}
              {scope.warnings.length > 0 ? ` · ${scope.warnings.join("；")}` : ""}
            </div>
          )}
          {scope.incompleteParentRefs.length > 0 ? (
            <div className="rounded-xs border border-warning/50 bg-warning/10 p-3 text-text ui-body">
              {t("views.workspace.incompleteParents", { refs: scope.incompleteParentRefs.join("、") })}
            </div>
          ) : null}

          {tab === "overview" ? (
            <WorkOverview
              submitted={submitted}
              stalled={stalled}
              leaves={leafRows}
              lanes={lanes}
              dayGroups={dayGroups}
              dayLabelOf={dayLabelOf}
              timeOf={(iso) => formatTime(iso, { style: "time" }) ?? "—"}
              subgroups={subgroups}
              leafCounts={leafCounts}
              agoOf={agoOf}
              feedback={feedback}
              onAdjudicate={
                onAdjudicate === undefined
                  ? undefined
                  : (task, decision, reason) => void onAdjudicate(task, decision, reason)
              }
              onAttest={onAttest}
              onConsent={onConsent}
              onOpenTask={openTask}
              onOpenProgress={() => setTab("progress")}
              onFilterStatus={(status) => {
                setStatusFilter(status);
                setTab("tasks");
              }}
              onFilterGroup={(group) => {
                // 点一组是「看这组的任务」这个新意图,不再叠着上一个状态过滤。
                setGroupFilter(group);
                setStatusFilter("");
                setTab("tasks");
              }}
            />
          ) : null}
          {tab === "tasks" ? (
            <div>
              <WorkTasksTab
                leaves={leafRows}
                subgroups={subgroups}
                statusFilter={statusFilter}
                groupFilter={groupFilter}
                query={query}
                agoOf={agoOf}
                onStatusFilter={setStatusFilter}
                onGroupFilter={setGroupFilter}
                onOpenTask={openTask}
                onLoadMore={scope.page.nextCursor === null ? undefined : onLoadMore}
                loadingMore={loadingMore}
              />
            </div>
          ) : null}
          {tab === "progress" ? (
            <div className="max-w-[900px]">
              {dayGroups.length > 0 ? (
                <WorkDayList
                  dayGroups={dayGroups}
                  dayLabelOf={dayLabelOf}
                  timeOf={(iso) => formatTime(iso, { style: "time" }) ?? "—"}
                  onOpenTask={openTask}
                />
              ) : (
                <p className="py-5 text-text-faint ui-body">{t("views.workspace.historyEmpty")}</p>
              )}
              <p className="mt-3 text-text-muted ui-meta">
                {t(scope.eventWindowComplete ? "views.workspace.windowComplete" : "views.workspace.windowPartial")}
              </p>
            </div>
          ) : null}
          {tab === "decisions" ? (
            <div>
              <WorkDecisionsTab
                decisions={workDecisions}
                facts={evidence.facts}
                missingRefs={evidence.missingRefs}
                relations={relations}
                titles={titles}
                query={query}
                agoOf={agoOf}
                onNavigateEntity={navigateEntity}
              />
            </div>
          ) : null}
          {tab === "inspect" ? (
            <div>
              <WorkInspectTab
                events={evidence.events}
                historyComplete={scope.eventWindowComplete}
                titles={titles}
                onNavigateEntity={navigateEntity}
              />
            </div>
          ) : null}
          {/* 关系图保持挂载:焦点与展开累积在页签切换间保留,active 只卸画布 DOM。 */}
          <div hidden={tab !== "graph"} className="flex min-h-0 flex-1 flex-col">
            <WorkGraphTab
              memberTaskIds={[scope.root.taskId, ...scope.memberTaskIds]}
              tasks={tasks}
              decisions={decisions}
              facts={facts}
              relations={relations}
              onNavigateEntity={navigateEntity}
              onSetTaskPin={onSetTaskPin}
              active={tab === "graph"}
            />
          </div>
          {tab === "root" && renderRootTask !== undefined ? (
            <section
              data-testid="workspace-root-task"
              className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-sm border border-border"
            >
              {renderRootTask(() => setTab("overview"))}
            </section>
          ) : null}
        </TabPanel>
      </div>

      <TaskPreviewDrawer
        task={drawerTask}
        tasks={tasks}
        relations={relations}
        onClose={() => setDrawerTaskId(null)}
        onOpenDetail={openFullDetail}
        onPreviewTask={openTask}
        onSetPin={onSetTaskPin}
      />
    </div>
  );
}

/** 一行目标(可展开):task_plan.md 的 Brief 段,收起时一行截断,点开看全文。 */
function WorkMission({
  repoId,
  taskId,
  path,
}: {
  readonly repoId: string;
  readonly taskId: string;
  readonly path: string;
}) {
  const query = useTaskDocumentQuery(repoId, taskId, path),
    [open, setOpen] = useState(false);
  if (query.data === undefined || query.data.status !== "ready") return null;
  const body = query.data.uncommitted && query.data.worktreeBody !== null ? query.data.worktreeBody : query.data.body,
    goal = body === null ? null : workspaceGoalLine(body);
  if (goal === null) return null;
  return (
    <div
      data-testid="workspace-mission"
      role="button"
      tabIndex={0}
      aria-expanded={open}
      title={t("views.workspace.missionTitle")}
      onClick={() => setOpen((value) => !value)}
      className={`mt-1 max-w-[110ch] cursor-pointer whitespace-pre-line text-text-muted ui-body ${open ? "" : "line-clamp-1"}`}
    >
      {goal}
    </div>
  );
}

import { TabPanel } from "../components/primitives/EntryBoundary.tsx";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, CaretRight, PushPin, TerminalWindow } from "@phosphor-icons/react";
import { EngineBadge, FreshnessTag } from "../components/badges.tsx";
import { SegBar } from "../components/primitives/SegBar";
import { StatusTag } from "../components/primitives/StatusTag";
import { Tabs } from "../components/primitives/Tabs";
import { TitleText } from "../components/primitives/TitleText";
import { EntityRefLink } from "../components/EntityRefLink.tsx";
import { ViewInGraphButton } from "../components/ViewInGraphButton.tsx";
import { TaskDispatchTab, TaskEvidenceTab, TaskOverviewTab } from "../components/taskDetail/TaskDetailSections.tsx";
import { TaskCloseoutTab } from "../components/taskDetail/TaskCloseoutTab.tsx";
import { TaskRelationsTab, type TaskDecisionRef } from "../components/taskDetail/TaskRelationsTab.tsx";
import { TaskDocumentSidebar, TaskFilesTab } from "../components/taskDetail/TaskFilesTab.tsx";
import { PhaseSteps } from "../components/taskDetail/PhaseSteps.tsx";
import type { RelationEdge, TaskRow } from "../model/types.ts";
import { isExternal } from "../model/types.ts";
import type { TaskMutationFeedback } from "../task-actions.ts";
import { useTaskDocumentQuery } from "../task-data.ts";
import { workspaceGoalLine } from "../model/workspace-narrative.ts";
import { t } from "../i18n/index.tsx";
import { AwaitsAskStrip } from "../components/AwaitsAskStrip.tsx";

// 视觉基线 v1(§2.2 文档型页头):tab 文案走 locales,定义只留 id;
// 标签栏用 primitives/Tabs(下划线式),不再各写一套 pill。
const tabs = [
  { id: "overview", labelKey: "views.taskDetailView.tabOverview" },
  { id: "dispatch", labelKey: "views.taskDetailView.tabDispatch" },
  { id: "evidence", labelKey: "views.taskDetailView.tabEvidence" },
  { id: "relations", labelKey: "views.taskDetailView.tabRelations" },
  { id: "closeout", labelKey: "views.taskDetailView.tabCloseout" },
  { id: "files", labelKey: "views.taskDetailView.tabFiles" },
] as const;

type TaskDetailTab = (typeof tabs)[number]["id"];

export function TaskDetailView({
  repoId,
  task,
  onBack,
  tasks,
  relations,
  decisions = [],
  onSelect,
  projectName,
  fromViewLabel = t("views.taskDetailView.workspace"),
  work = null,
  onOpenWork,
  onNavigateDecision,
  onNavigateEntity,
  onOpenTerminal,
  mutationFeedback,
  onProgress,
  onSubmit,
  onComplete,
  onAdjudicate,
  onConsentReview,
  onAttest,
  onSetPin,
  onFocusGraph,
  initialTab,
  initialRecordFocus,
}: {
  /** 当前仓;给出时详情头下列出挂在本任务上、等你答复 / 已答复的 awaits(同一答复面板)。 */
  repoId?: string;
  task: TaskRow;
  onBack: () => void;
  tasks?: readonly TaskRow[];
  relations?: RelationEdge[];
  /** 身份/标题/状态即可(常驻摘要投影就够);证据页签自己读全量决策行。 */
  decisions?: readonly TaskDecisionRef[];
  onSelect?: (id: string) => void;
  projectName: string;
  fromViewLabel?: string;
  /** 本任务所属的工作(dec_5F7E74F1:最近的声明工作祖先,否则最顶层祖先);顶层任务为 null。 */
  work?: { readonly taskId: string; readonly title: string } | null;
  onOpenWork?: (taskId: string) => void;
  /** G10 实体互链:详情页内出现的其他实体 ID 必须有路;必填,不给回调就没有路。 */
  onNavigateDecision: (decisionId: string) => void;
  onNavigateEntity: (ref: string) => void;
  /** 「打开终端」:在终端页建一个绑定本 task 的会话(App 负责切页与建会话)。 */
  onOpenTerminal?: (task: TaskRow) => void;
  mutationFeedback?: TaskMutationFeedback;
  onProgress?: (input: {
    text: string;
    evidence: ReadonlyArray<{ type: string; path: string; summary: string }>;
  }) => Promise<unknown>;
  onSubmit?: () => Promise<unknown>;
  /** 收口销账写通道(`ha task complete` 同一动作);缺省时完成面板只读。 */
  onComplete?: () => Promise<unknown>;
  onAdjudicate?: (decision: "forward" | "return", reason: string, reviewId?: string) => Promise<unknown>;
  onConsentReview?: (reviewId: string) => Promise<unknown>;
  /** Gate 签注写通道(`ha task attest` 同一动作);缺省时签注卡只读。 */
  onAttest?: (
    task: Pick<TaskRow, "taskId">,
    gateId: string,
    mode: "approve" | "override",
    rationale?: string,
  ) => Promise<TaskMutationFeedback>;
  /** 台账 pin 写通道(`ha task pin` 同一动作);缺省时只显示 📌 状态。 */
  onSetPin?: (task: TaskRow, pinned: boolean) => void;
  /** 统一「在关系图中查看」入口(task_89d324b5);缺省不渲染。 */
  onFocusGraph?: (ref: string) => void;
  /** 打开时停在的页签;议程评审类落点(taskreview/<id>)传 closeout。缺省为概况。 */
  initialTab?: TaskDetailTab;
  /** 打开时聚焦的收口记录(execution/<id> 等);给出时停在收口页签对应记录行(预览抽屉的反向入口)。 */
  initialRecordFocus?: string;
}) {
  // 记录聚焦蕴含收口页签:详情落点在收口记录行里(显式 initialTab 优先)。
  const initialTabOf = initialTab ?? (initialRecordFocus !== undefined ? "closeout" : "overview");
  const [activeTab, setActiveTab] = useState<TaskDetailTab>(initialTabOf);
  const [activeDoc, setActiveDoc] = useState("task_plan.md");
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);
  const [focusedRecordRef, setFocusedRecordRef] = useState<string | null>(initialRecordFocus ?? null);
  const external = isExternal(task);
  const pinned = task.pinned === true;

  useEffect(() => {
    setActiveTab(initialTabOf);
    setActiveDoc("task_plan.md");
    setFocusedSessionId(null);
    setFocusedRecordRef(initialRecordFocus ?? null);
  }, [task.taskId, initialTabOf, initialRecordFocus]);

  const selectTab = (tab: TaskDetailTab) => {
    setActiveTab(tab);
    if (tab !== "dispatch") setFocusedSessionId(null);
  };
  const openSession = (runtimeSessionId: string) => {
    setFocusedSessionId(runtimeSessionId);
    setActiveTab("dispatch");
  };
  // 时间线引用对象(execution/review/…)的详情落点:这些记录没有独立详情页,
  // 它们的详情就是收口页签里的对应记录行——聚焦导航发生在任务详情内部,
  // 任务上下文与返回栈不受影响(与 openSession 同一模式)。
  const openCloseoutRecord = (recordRef: string) => {
    setFocusedRecordRef(recordRef);
    selectTab("closeout");
  };
  const openDocument = useCallback((path: string) => {
    setActiveDoc(path);
    setFocusedSessionId(null);
    setActiveTab("files");
  }, []);

  // 一行目标(§2.2):task_plan 的 Brief,与概况页签/工作页同一提取器、同一查询缓存。
  const plan = useTaskDocumentQuery(task.projectId, task.taskId, "task_plan.md");
  const goal = plan.data?.status === "ready" && plan.data.body !== null ? workspaceGoalLine(plan.data.body) : null;
  // 子任务分段进度条(§2.2):只对有子任务的行渲染,叶子任务空了就消失。
  const childCounts = useMemo(() => {
    const counts: Partial<Record<TaskRow["coordinationStatus"], number>> = {};
    for (const row of tasks ?? [])
      if (row.parentTaskId === task.taskId) counts[row.coordinationStatus] = (counts[row.coordinationStatus] ?? 0) + 1;
    return counts;
  }, [tasks, task.taskId]);
  const childTotal = Object.values(childCounts).reduce((sum, count) => sum + count, 0);
  const gatesPassed = task.gates.filter((gate) => gate.ok === true).length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg" data-testid="task-detail-view">
      {/* 视觉基线 v1 §2.2 文档型页头:面包屑 / 标题+状态 / 一行目标(可展开) /
          生命周期进度与关键数字 / 标签栏。徽标一律 shrink-0 + whitespace-nowrap,
          标题与面包屑截断,长标题/长徽标不再把头部撑高;头部行允许换行(原则 9②),
          窄屏下动作钮折到面包屑下一行、逐钮换行,不越出视口。 */}
      <header className="relative z-20 shrink-0 border-b border-border bg-surface/80" data-testid="task-detail-header">
        <div className="flex min-h-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1 lg:px-4">
          <button
            type="button"
            onClick={onBack}
            aria-label={t("views.taskDetailView.returnPreviousLevel")}
            className={[
              "grid size-6 shrink-0 place-items-center rounded-sm border border-border text-text-muted",
              "hover:border-border-strong hover:bg-surface-raised hover:text-text",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            ].join(" ")}
          >
            <ArrowLeft weight="bold" className="ui-meta" />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden font-mono ui-micro leading-3 text-text-faint">
            <button type="button" onClick={onBack} className="truncate hover:text-text-muted">
              {projectName}
            </button>
            <CaretRight weight="bold" className="shrink-0" />
            <button type="button" onClick={onBack} className="truncate hover:text-text-muted">
              {fromViewLabel}
            </button>
            <CaretRight weight="bold" className="shrink-0" />
            {work && onOpenWork ? (
              <>
                <button
                  type="button"
                  data-testid="task-detail-work"
                  onClick={() => onOpenWork(work.taskId)}
                  title={work.taskId}
                  className="max-w-[18rem] shrink-0 truncate font-sans text-accent hover:underline"
                >
                  {t("views.taskDetailView.belongsToWork", { title: work.title })}
                </button>
                <CaretRight weight="bold" className="shrink-0" />
              </>
            ) : null}
            <EntityRefLink
              entityRef={`task/${task.taskId}`}
              onNavigate={onNavigateEntity}
              title={task.taskId}
              className="font-mono ui-micro leading-3 text-text-muted hover:text-accent hover:underline"
            />
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="whitespace-nowrap">
              <EngineBadge engine={task.engine} locked={external} />
            </span>
            {onOpenTerminal && (
              <button
                type="button"
                data-testid="task-detail-open-terminal"
                onClick={() => onOpenTerminal(task)}
                title={t("views.taskDetailView.openTerminal")}
                className={[
                  "flex shrink-0 items-center gap-1 rounded-sm border border-border px-1.5 py-1 font-mono ui-micro",
                  "text-text-faint hover:border-border-strong hover:text-text-muted",
                ].join(" ")}
              >
                <TerminalWindow weight="bold" />
                {t("views.taskDetailView.openTerminal")}
              </button>
            )}
            {onSetPin ? (
              <button
                type="button"
                data-testid="task-detail-pin-toggle"
                onClick={() => onSetPin(task, !pinned)}
                aria-pressed={pinned}
                title={pinned ? t("views.taskDetailView.unpinTitle") : t("views.taskDetailView.pinTitle")}
                className={[
                  "flex shrink-0 items-center gap-1 rounded-sm border px-1.5 py-1 font-mono ui-micro",
                  pinned
                    ? "border-accent/50 bg-accent/10 text-accent"
                    : "border-border text-text-faint hover:border-border-strong hover:text-text-muted",
                ].join(" ")}
              >
                <PushPin weight={pinned ? "fill" : "bold"} />
                {pinned ? t("views.taskDetailView.pinnedToday") : t("views.taskDetailView.pinAction")}
              </button>
            ) : (
              pinned && (
                <span
                  data-testid="task-detail-pinned-marker"
                  className={[
                    "flex shrink-0 items-center gap-1 rounded-sm border",
                    "border-accent/50 bg-accent/10 px-1.5 py-1 font-mono ui-micro text-accent",
                  ].join(" ")}
                >
                  <PushPin weight="fill" />
                  {t("views.taskDetailView.pinnedToday")}
                </span>
              )
            )}
            <details className="group relative shrink-0">
              <summary
                className={[
                  "list-none rounded-sm border border-border px-2 py-1 font-mono ui-micro text-text-muted",
                  "hover:border-border-strong hover:bg-surface-raised hover:text-text",
                  "[&::-webkit-details-marker]:hidden",
                ].join(" ")}
              >
                {t("views.taskDetailView.identity")}
              </summary>
              <dl
                className={[
                  "absolute right-0 top-[calc(100%+0.5rem)] z-40 grid w-[min(56rem,calc(100vw-2rem))]",
                  "overflow-hidden rounded border border-border-strong bg-surface shadow-2xl",
                  "sm:grid-cols-2 lg:grid-cols-3",
                ].join(" ")}
                data-testid="task-identity-strip"
              >
                <IdentityItem
                  label="TASK ID"
                  value={task.taskId}
                  onClick={() => onNavigateEntity(`task/${task.taskId}`)}
                />
                <IdentityItem
                  label="PARENT"
                  value={task.parentTaskId ?? "root"}
                  onClick={task.parentTaskId && onSelect ? () => onSelect(task.parentTaskId!) : undefined}
                />
                <IdentityItem
                  label="LIFECYCLE / STATUS"
                  value={`${task.engine} · ${task.canonicalStatus ?? task.coordinationStatus}`}
                />
                <IdentityItem
                  label={t("views.taskDetailView.stage")}
                  value={`${task.currentNode ?? "—"} · iteration ${task.iteration ?? "—"}`}
                />
                <IdentityItem
                  label="LEASE"
                  value={
                    task.activeExecutionId
                      ? `${task.activeExecutionId} · ${task.leaseHolder ?? "—"} · ${
                          task.leasePhase ?? "—"
                        } · ${task.leaseExpiresAt ?? "—"}`
                      : "—"
                  }
                  wide
                />
                <IdentityItem label="PRESET / VERTICAL" value={`${task.preset ?? "—"} · ${task.vertical ?? "—"}`} />
                <IdentityItem label="RISK / URGENCY" value={`${task.riskTier ?? "—"} · ${task.urgency ?? "—"}`} />
                <IdentityItem label="OWNER / CLASS" value={`${task.createdBy ?? "—"} · ${task.taskClass ?? "—"}`} />
                <IdentityItem label="WORK KIND" value={task.workKind ?? "—"} />
                <IdentityItem label="PACKAGE PATH" value={task.packagePath ?? "未物化"} wide />
                <IdentityItem
                  label={t("views.taskDetailView.workspace")}
                  value={
                    task.workspace?.kind === "worktree"
                      ? `${task.workspace.path} · ${task.workspace.branch} · ${task.workspace.state}`
                      : task.workspace
                        ? t("views.taskDetailView.taskPackageWorkspace", { path: task.workspace.path })
                        : "—"
                  }
                  wide
                />
              </dl>
            </details>
            {/* 会话页重构(任务 task_1994d52c):Task 详情反向入口,落 sessions 页该任务的
                会话组(tasksessions/<taskId> 可寻址,回撤原路返回)。 */}
            <button
              type="button"
              data-testid="task-open-sessions"
              onClick={() => onNavigateEntity(`tasksessions/${task.taskId}`)}
              className={
                "flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-1 font-mono ui-micro " +
                "text-text-faint hover:text-accent"
              }
            >
              {t("views.taskDetailView.openSessions")} ↗
            </button>
            {/* 统一「在关系图中查看」入口(task_89d324b5):task 是图节点 kind。 */}
            <ViewInGraphButton entityRef={`task/${task.taskId}`} onFocusGraph={onFocusGraph} />
          </div>
        </div>
        {/* 标题行:标题经 TitleText(冒号前重点、冒号后弱色),状态徽标同行不换行。 */}
        <div className="flex min-h-0 items-center gap-3 px-3 pb-1 lg:px-4">
          <h1
            title={task.title}
            className="min-w-0 flex-1 truncate ui-body font-semibold leading-6 tracking-[-0.01em] text-text"
          >
            <TitleText title={task.title} />
          </h1>
          <span className="flex shrink-0 items-center gap-2 whitespace-nowrap">
            <StatusTag status={task.coordinationStatus} />
            <FreshnessTag freshness={task.freshness} lastKnownAt={task.lastKnownAt} />
          </span>
        </div>
        {/* 一行目标(可展开):收起时一行截断,点开看全文;无 Brief 时不渲染。 */}
        {goal !== null && <TaskGoalLine goal={goal} />}
        {/* 生命周期进度与关键数字:阶段投影步进条 + 子任务分段(有子任务才有) + 数字。 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 pb-1.5 lg:px-4">
          <div data-testid="task-detail-phase" className="min-w-0 max-w-[520px] flex-1">
            <PhaseSteps phase={task.phase} />
          </div>
          {childTotal > 0 ? <SegBar counts={childCounts} className="h-[5px] max-w-[320px] flex-1" /> : null}
          <span className="ml-auto whitespace-nowrap font-mono tabular-nums text-text-muted ui-meta">
            {t("views.taskDetailView.keyNumbers", {
              gatesPassed,
              gatesTotal: task.gates.length,
              docsPresent: task.docs.filter((doc) => doc.present).length,
              docsTotal: task.docs.length,
            })}
            {childTotal > 0
              ? ` · ${t("views.taskDetailView.childNumbers", {
                  done: childCounts.done ?? 0,
                  total: childTotal,
                })}`
              : ""}
          </span>
        </div>
        <div className="px-3 pb-1 lg:px-4">
          <div data-testid="task-detail-tabs">
            <Tabs
              ariaLabel={t("views.taskDetailView.sectionsAria")}
              idPrefix="task"
              value={activeTab}
              onChange={selectTab}
              tabs={tabs.map((tab) => ({ key: tab.id, label: t(tab.labelKey) }))}
            />
          </div>
        </div>
      </header>
      {repoId ? (
        <AwaitsAskStrip repoId={repoId} sourceRef={`task/${task.taskId}`} onNavigateEntity={onNavigateEntity} />
      ) : null}

      {/* 宽屏自适应:main 是容器量尺(内容盒宽 = 卡片宽),卡片铺满可用宽度。
          断带:容器 <1100px 单栏叠放(文件树横排在上,量高 18rem 内滚,不挤死正文);
          ≥1100px 文件树收窄为 14rem 侧栏。 */}
      <main className="@container min-h-0 flex-1 overflow-hidden px-3 py-2 sm:px-4">
        <div
          className={[
            "h-full w-full overflow-hidden rounded-sm border border-border bg-bg",
            "grid grid-cols-1 grid-rows-[auto_minmax(0,1fr)]",
            "@min-[1100px]:grid-cols-[14rem_minmax(0,1fr)] @min-[1100px]:grid-rows-1",
          ].join(" ")}
        >
          <TaskDocumentSidebar
            task={task}
            activeDoc={activeDoc}
            onActiveDocChange={setActiveDoc}
            onOpenDoc={openDocument}
          />
          {/* 概况是一屏的区域板:面板自己是板的容器量尺(量面板内容宽,不含文件树),
              ≥900px 时板占满面板高度、区域在自己内部滚动;其余页签随内容往下排。 */}
          <TabPanel
            idPrefix="task"
            value={activeTab}
            className={`min-h-0 min-w-0 overflow-y-auto px-4 py-4 lg:px-6 ${
              activeTab === "overview" ? "@container flex flex-col" : ""
            }`}
            data-testid="task-detail-panel-scroll"
          >
            {activeTab === "overview" ? (
              <TaskOverviewTab
                task={task}
                onOpenCloseout={() => selectTab("closeout")}
                onOpenRecord={openCloseoutRecord}
              />
            ) : activeTab === "dispatch" ? (
              <TaskDispatchTab task={task} focusedSessionId={focusedSessionId} onNavigateEntity={onNavigateEntity} />
            ) : activeTab === "evidence" ? (
              <TaskEvidenceTab task={task} tasks={tasks} relations={relations} onNavigateEntity={onNavigateEntity} />
            ) : activeTab === "relations" ? (
              <TaskRelationsTab
                task={task}
                tasks={tasks}
                decisions={decisions}
                onSelect={onSelect}
                onNavigateDecision={onNavigateDecision}
                onNavigateEntity={onNavigateEntity}
                onOpenSession={openSession}
              />
            ) : activeTab === "closeout" ? (
              <TaskCloseoutTab
                task={task}
                focusedRecordRef={focusedRecordRef}
                mutationFeedback={mutationFeedback}
                onProgress={onProgress}
                onSubmit={onSubmit}
                onComplete={onComplete}
                onAdjudicate={onAdjudicate}
                onConsentReview={onConsentReview}
                onAttest={onAttest}
              />
            ) : (
              <TaskFilesTab task={task} activeDoc={activeDoc} onOpenDoc={openDocument} />
            )}
          </TabPanel>
        </div>
      </main>
    </div>
  );
}

/** 一行目标(§2.2,与工作页 WorkMission 同一形态):收起一行截断,点开全文。 */
function TaskGoalLine({ goal }: { readonly goal: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      data-testid="task-goal-line"
      role="button"
      tabIndex={0}
      aria-expanded={open}
      title={t("views.taskDetailView.goalTitle")}
      onClick={() => setOpen((value) => !value)}
      className={`mx-3 max-w-[110ch] cursor-pointer whitespace-pre-line text-text-muted ui-body lg:mx-4 ${
        open ? "" : "line-clamp-1"
      }`}
    >
      {goal}
    </div>
  );
}

interface IdentityItemProps {
  readonly label: string;
  readonly value: string;
  readonly detail?: React.ReactNode;
  readonly wide?: boolean;
  readonly onClick?: () => void;
}

function IdentityItem({ label, value, detail, wide = false, onClick }: IdentityItemProps) {
  return (
    <div className={`min-w-0 border-r border-b border-border/70 px-3 py-2 ${wide ? "sm:col-span-2" : ""}`}>
      <dt className="font-mono ui-micro font-semibold uppercase tracking-[0.16em] text-text-faint">{label}</dt>
      <dd title={value} className="mt-1 min-w-0 truncate font-mono ui-micro text-text-muted">
        {onClick ? (
          <button type="button" onClick={onClick} className="text-accent hover:underline">
            {value}
          </button>
        ) : (
          value
        )}
      </dd>
      {detail ? <div className="mt-2 min-w-0">{detail}</div> : null}
    </div>
  );
}

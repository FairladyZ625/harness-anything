import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import {
  ArrowLeft,
  CaretRight,
  CirclesFour,
  FileText,
  Flag,
  LinkSimple,
  SealCheck,
  ShareNetwork,
} from "@phosphor-icons/react";
import type { GuiSubmissionV1 } from "../../api/renderer-dto.ts";
import { EngineBadge, FreshnessTag, StatusBadge } from "../components/badges.tsx";
import { EntityRefLink } from "../components/EntityRefLink.tsx";
import {
  TaskCloseoutTab,
  TaskDispatchTab,
  TaskEvidenceTab,
  TaskOverviewTab,
  TaskRelationsTab,
} from "../components/taskDetail/TaskDetailSections.tsx";
import { TaskDocumentSidebar, TaskFilesTab } from "../components/taskDetail/TaskFilesTab.tsx";
import { PhaseSteps } from "../components/taskDetail/PhaseSteps.tsx";
import type { DecisionRow, RelationEdge, TaskRow } from "../model/types.ts";
import { isExternal } from "../model/types.ts";
import type { TaskMutationFeedback } from "../task-actions.ts";
import { t } from "../i18n/index.tsx";

// 密度重做(task_9f39e256):tab 文案走 locales,定义只留 id/icon,label 渲染期取。
const tabs = [
  { id: "overview", labelKey: "views.taskDetailView.tabOverview", icon: CirclesFour },
  { id: "dispatch", labelKey: "views.taskDetailView.tabDispatch", icon: ShareNetwork },
  { id: "evidence", labelKey: "views.taskDetailView.tabEvidence", icon: Flag },
  { id: "relations", labelKey: "views.taskDetailView.tabRelations", icon: LinkSimple },
  { id: "closeout", labelKey: "views.taskDetailView.tabCloseout", icon: SealCheck },
  { id: "files", labelKey: "views.taskDetailView.tabFiles", icon: FileText },
] as const;

type TaskDetailTab = (typeof tabs)[number]["id"];

export function TaskDetailView({
  task,
  onBack,
  tasks,
  relations,
  decisions = [],
  onSelect,
  projectName,
  fromViewLabel = t("views.taskDetailView.workspace"),
  onNavigateDecision,
  onNavigateEntity,
  mutationFeedback,
  onProgress,
  onSubmit,
}: {
  task: TaskRow;
  onBack: () => void;
  tasks?: TaskRow[];
  relations?: RelationEdge[];
  decisions?: DecisionRow[];
  onSelect?: (id: string) => void;
  projectName: string;
  fromViewLabel?: string;
  /** G10 实体互链:详情页内出现的其他实体 ID 必须有路;必填,不给回调就没有路。 */
  onNavigateDecision: (decisionId: string) => void;
  onNavigateEntity: (ref: string) => void;
  mutationFeedback?: TaskMutationFeedback;
  onProgress?: (input: {
    text: string;
    evidence: ReadonlyArray<{ type: string; path: string; summary: string }>;
  }) => Promise<unknown>;
  onSubmit?: (submission: GuiSubmissionV1) => Promise<unknown>;
}) {
  const [activeTab, setActiveTab] = useState<TaskDetailTab>("overview");
  const [activeDoc, setActiveDoc] = useState("task_plan.md");
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);
  const external = isExternal(task);

  useEffect(() => {
    setActiveTab("overview");
    setActiveDoc("task_plan.md");
    setFocusedSessionId(null);
  }, [task.taskId]);

  const selectTab = (tab: TaskDetailTab) => {
    setActiveTab(tab);
    if (tab !== "dispatch") setFocusedSessionId(null);
  };
  const openSession = (runtimeSessionId: string) => {
    setFocusedSessionId(runtimeSessionId);
    setActiveTab("dispatch");
  };
  const openDocument = useCallback((path: string) => {
    setActiveDoc(path);
    setFocusedSessionId(null);
    setActiveTab("files");
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg" data-testid="task-detail-view">
      {/* 信息密度(task_9f39e256):顶部元数据压成两行——第 1 行面包屑 + 视图控件,
          第 2 行标题 + 状态徽标 + 分区 tab;tab 并入头部不再独占整行。徽标一律
          shrink-0 + whitespace-nowrap,标题与面包屑截断,长标题/长徽标不再把头部撑高。 */}
      <header className="relative z-20 shrink-0 border-b border-border bg-surface/80" data-testid="task-detail-header">
        <div className="flex min-h-0 items-center gap-2 px-3 py-1 lg:px-4">
          <button
            type="button"
            onClick={onBack}
            aria-label={t("views.taskDetailView.returnPreviousLevel")}
            className={[
              "grid size-6 shrink-0 place-items-center rounded-md border border-border text-text-muted",
              "hover:border-border-strong hover:bg-surface-raised hover:text-text",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            ].join(" ")}
          >
            <ArrowLeft weight="bold" className="text-[12px]" />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-1 font-mono text-[9px] leading-3 text-text-faint">
            <button type="button" onClick={onBack} className="truncate hover:text-text-muted">
              {projectName}
            </button>
            <CaretRight weight="bold" className="shrink-0" />
            <button type="button" onClick={onBack} className="truncate hover:text-text-muted">
              {fromViewLabel}
            </button>
            <CaretRight weight="bold" className="shrink-0" />
            <EntityRefLink
              entityRef={`task/${task.taskId}`}
              onNavigate={onNavigateEntity}
              title={task.taskId}
              className="truncate font-mono text-[9px] leading-3 text-text-muted hover:text-accent hover:underline"
            />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="whitespace-nowrap">
              <EngineBadge engine={task.engine} locked={external} />
            </span>
            <details className="group relative shrink-0">
              <summary
                className={[
                  "list-none rounded-md border border-border px-2 py-1 font-mono text-[10px] text-text-muted",
                  "hover:border-border-strong hover:bg-surface-raised hover:text-text",
                  "[&::-webkit-details-marker]:hidden",
                ].join(" ")}
              >
                {t("views.taskDetailView.identity")}
              </summary>
              <dl
                className={[
                  "absolute right-0 top-[calc(100%+0.5rem)] z-40 grid w-[min(56rem,calc(100vw-2rem))]",
                  "overflow-hidden rounded-lg border border-border-strong bg-surface shadow-2xl",
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
                  detail={<PhaseSteps status={task.canonicalStatus ?? task.coordinationStatus} />}
                />
                <IdentityItem label="PRESET / VERTICAL" value={`${task.preset ?? "—"} · ${task.vertical ?? "—"}`} />
                <IdentityItem label="RISK / URGENCY" value={`${task.riskTier ?? "—"} · ${task.urgency ?? "—"}`} />
                <IdentityItem label="OWNER / CLASS" value={`${task.createdBy ?? "—"} · ${task.taskClass ?? "—"}`} />
                <IdentityItem label="WORK KIND" value={task.workKind ?? "—"} />
                <IdentityItem label="PACKAGE PATH" value={task.packagePath ?? "未物化"} wide />
              </dl>
            </details>
            {/* 会话页重构(任务 task_1994d52c):Task 详情反向入口,落 sessions 页该任务的
                会话组(tasksessions/<taskId> 可寻址,回撤原路返回)。 */}
            <button
              type="button"
              data-testid="task-open-sessions"
              onClick={() => onNavigateEntity(`tasksessions/${task.taskId}`)}
              className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[10px] text-text-faint hover:text-accent"
            >
              {t("views.taskDetailView.openSessions")} ↗
            </button>
          </div>
        </div>
        <div className="flex min-h-0 items-center gap-3 px-3 pb-1.5 lg:px-4">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h1
              title={task.title}
              className="truncate text-[14px] font-semibold leading-6 tracking-[-0.01em] text-text"
            >
              {task.title}
            </h1>
            <span className="flex shrink-0 items-center gap-2 whitespace-nowrap">
              <StatusBadge status={task.coordinationStatus} />
              <FreshnessTag freshness={task.freshness} lastKnownAt={task.lastKnownAt} />
            </span>
          </div>
          <nav
            role="tablist"
            aria-label={t("views.taskDetailView.sectionsAria")}
            data-testid="task-detail-tabs"
            className="flex shrink-0 items-center gap-0.5 overflow-x-auto"
          >
            {tabs.map((tab, index) => {
              const Icon = tab.icon,
                active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  id={`task-tab-${tab.id}`}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls={`task-panel-${tab.id}`}
                  tabIndex={active ? 0 : -1}
                  onClick={() => selectTab(tab.id)}
                  onKeyDown={(event) => navigateTabs(event, index, selectTab)}
                  className={[
                    "flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium",
                    "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
                    active ? "bg-surface-raised text-text" : "text-text-faint hover:text-text-muted",
                  ].join(" ")}
                >
                  <Icon weight={active ? "bold" : "regular"} className="text-[11px]" />
                  {t(tab.labelKey)}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      {/* 宽屏自适应:main 是容器量尺(内容盒宽 = 卡片宽),卡片铺满可用宽度。
          断带:容器 <1100px 单栏叠放(文件树横排在上,量高 18rem 内滚,不挤死正文);
          ≥1100px 文件树收窄为 14rem 侧栏。密度(task_9f39e256):外衬收窄,
          首屏尽量早见到正文。 */}
      <main className="@container min-h-0 flex-1 overflow-hidden px-3 py-2 sm:px-4">
        <div
          className={[
            "h-full w-full overflow-hidden rounded-lg border border-border bg-bg",
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
          <section
            id={`task-panel-${activeTab}`}
            role="tabpanel"
            aria-labelledby={`task-tab-${activeTab}`}
            className="min-h-0 min-w-0 overflow-y-auto px-4 py-4 lg:px-6"
            data-testid="task-detail-panel-scroll"
          >
            {activeTab === "overview" ? (
              <TaskOverviewTab task={task} />
            ) : activeTab === "dispatch" ? (
              <TaskDispatchTab task={task} focusedSessionId={focusedSessionId} onNavigateEntity={onNavigateEntity} />
            ) : activeTab === "evidence" ? (
              <TaskEvidenceTab
                task={task}
                tasks={tasks}
                relations={relations}
                decisions={decisions}
                onNavigateEntity={onNavigateEntity}
              />
            ) : activeTab === "relations" ? (
              <TaskRelationsTab
                task={task}
                tasks={tasks}
                relations={relations}
                decisions={decisions}
                onSelect={onSelect}
                onNavigateDecision={onNavigateDecision}
                onNavigateEntity={onNavigateEntity}
                onOpenSession={openSession}
              />
            ) : activeTab === "closeout" ? (
              <TaskCloseoutTab
                task={task}
                mutationFeedback={mutationFeedback}
                onProgress={onProgress}
                onSubmit={onSubmit}
              />
            ) : (
              <TaskFilesTab task={task} activeDoc={activeDoc} />
            )}
          </section>
        </div>
      </main>
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
      <dt className="font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-text-faint">{label}</dt>
      <dd title={value} className="mt-1 min-w-0 truncate font-mono text-[11px] text-text-muted">
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

function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number, select: (tab: TaskDetailTab) => void) {
  const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (direction === 0) return;
  event.preventDefault();
  const next = (index + direction + tabs.length) % tabs.length;
  const tab = tabs[next]!;
  select(tab.id);
  event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#task-tab-${tab.id}`)?.focus();
}

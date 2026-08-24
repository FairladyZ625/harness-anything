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

const tabs = [
  { id: "overview", label: "概况", icon: CirclesFour },
  { id: "dispatch", label: "派工", icon: ShareNetwork },
  { id: "evidence", label: "证据", icon: Flag },
  { id: "relations", label: "关系", icon: LinkSimple },
  { id: "closeout", label: "收口", icon: SealCheck },
  { id: "files", label: "文件", icon: FileText },
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
      <header className="relative z-20 shrink-0 border-b border-border bg-surface/80" data-testid="task-detail-header">
        <div className="flex min-h-14 items-center gap-2.5 px-3 py-2 lg:px-4">
          <button
            type="button"
            onClick={onBack}
            aria-label={t("views.taskDetailView.returnPreviousLevel")}
            className={[
              "grid size-7 shrink-0 place-items-center rounded-md border border-border text-text-muted",
              "hover:border-border-strong hover:bg-surface-raised hover:text-text",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
            ].join(" ")}
          >
            <ArrowLeft weight="bold" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1 font-mono text-[9px] leading-3 text-text-faint">
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
            <div className="mt-0.5 flex min-w-0 items-center gap-2">
              <h1 className="truncate text-[16px] font-semibold leading-5 tracking-[-0.01em] text-text">
                {task.title}
              </h1>
              <StatusBadge status={task.coordinationStatus} />
              <FreshnessTag freshness={task.freshness} lastKnownAt={task.lastKnownAt} />
            </div>
          </div>
          <EngineBadge engine={task.engine} locked={external} />
          <details className="group relative shrink-0">
            <summary
              className={[
                "list-none rounded-md border border-border px-2 py-1.5 font-mono text-[10px] text-text-muted",
                "hover:border-border-strong hover:bg-surface-raised hover:text-text",
                "[&::-webkit-details-marker]:hidden",
              ].join(" ")}
            >
              身份信息
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
                label="阶段"
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
        </div>
      </header>

      <nav
        role="tablist"
        aria-label="Task 详情分区"
        className="relative z-10 flex h-8 shrink-0 overflow-x-auto border-b border-border bg-surface px-2 sm:px-3"
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
                "relative flex h-8 shrink-0 items-center gap-1 px-2 text-[11px] font-medium",
                "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
                active ? "text-text" : "text-text-faint hover:text-text-muted",
              ].join(" ")}
            >
              <Icon weight={active ? "bold" : "regular"} className="text-[12px]" />
              {tab.label}
              {active ? <span className="absolute inset-x-2 bottom-0 h-0.5 bg-accent" /> : null}
            </button>
          );
        })}
      </nav>

      <main className="min-h-0 flex-1 overflow-hidden px-3 py-3 sm:px-4">
        <div
          className={[
            "mx-auto h-full w-full max-w-[96rem] overflow-hidden rounded-lg border border-border bg-bg",
            "md:grid md:grid-cols-[14rem_minmax(0,1fr)]",
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
            className="min-h-0 min-w-0 overflow-y-auto px-4 py-5 lg:px-6"
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

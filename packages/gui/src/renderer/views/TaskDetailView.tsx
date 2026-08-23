import { useEffect, useState, type KeyboardEvent } from "react";
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
import {
  TaskCloseoutTab,
  TaskDispatchTab,
  TaskEvidenceTab,
  TaskOverviewTab,
  TaskRelationsTab,
} from "../components/taskDetail/TaskDetailSections.tsx";
import { TaskFilesTab } from "../components/taskDetail/TaskFilesTab.tsx";
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
  onNavigateDecision?: (decisionId: string) => void;
  onNavigateEntity?: (ref: string) => void;
  mutationFeedback?: TaskMutationFeedback;
  onProgress?: (input: { text: string; evidence: ReadonlyArray<{ type: string; path: string; summary: string }> }) => Promise<unknown>;
  onSubmit?: (submission: GuiSubmissionV1) => Promise<unknown>;
}) {
  const [activeTab, setActiveTab] = useState<TaskDetailTab>("overview");
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);
  const external = isExternal(task);

  useEffect(() => {
    setActiveTab("overview");
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

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg" data-testid="task-detail-view">
      <header className="shrink-0 border-b border-border bg-surface/80">
        <div className="flex items-start gap-3 px-4 py-3 lg:px-6">
          <button type="button" onClick={onBack} aria-label={t("views.taskDetailView.returnPreviousLevel")} className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md border border-border text-text-muted hover:border-border-strong hover:bg-surface-raised hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            <ArrowLeft weight="bold" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-text-faint">
              <button type="button" onClick={onBack} className="truncate hover:text-text-muted">{projectName}</button>
              <CaretRight weight="bold" className="shrink-0" />
              <button type="button" onClick={onBack} className="truncate hover:text-text-muted">{fromViewLabel}</button>
              <CaretRight weight="bold" className="shrink-0" />
              <span className="shrink-0 text-text-muted">{task.taskId}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-[18px] font-semibold leading-6 tracking-[-0.01em] text-text">{task.title}</h1>
              <StatusBadge status={task.coordinationStatus} />
              <FreshnessTag freshness={task.freshness} lastKnownAt={task.lastKnownAt} />
            </div>
          </div>
          <EngineBadge engine={task.engine} locked={external} />
        </div>

        <dl className="grid border-t border-border/80 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-6" data-testid="task-identity-strip">
          <IdentityItem label="TASK ID" value={task.taskId} />
          <IdentityItem label="PARENT" value={task.parentTaskId ?? "root"} onClick={task.parentTaskId && onSelect ? () => onSelect(task.parentTaskId!) : undefined} />
          <IdentityItem label="LIFECYCLE / STATUS" value={`${task.engine} · ${task.canonicalStatus ?? task.coordinationStatus}`} />
          <IdentityItem label="阶段" value={`${task.currentNode ?? "—"} · iteration ${task.iteration ?? "—"}`} detail={<PhaseSteps status={task.canonicalStatus ?? task.coordinationStatus} />} />
          <IdentityItem label="PRESET / VERTICAL" value={`${task.preset ?? "—"} · ${task.vertical ?? "—"}`} />
          <IdentityItem label="RISK / URGENCY" value={`${task.riskTier ?? "—"} · ${task.urgency ?? "—"}`} />
          <IdentityItem label="OWNER / CLASS" value={`${task.createdBy ?? "—"} · ${task.taskClass ?? "—"}`} />
          <IdentityItem label="WORK KIND" value={task.workKind ?? "—"} />
          <IdentityItem label="PACKAGE PATH" value={task.packagePath ?? "未物化"} wide />
        </dl>
      </header>

      <nav role="tablist" aria-label="Task 详情分区" className="flex shrink-0 overflow-x-auto border-b border-border bg-surface px-3 sm:px-5">
        {tabs.map((tab, index) => {
          const Icon = tab.icon, active = activeTab === tab.id;
          return <button
            key={tab.id}
            id={`task-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`task-panel-${tab.id}`}
            tabIndex={active ? 0 : -1}
            onClick={() => selectTab(tab.id)}
            onKeyDown={(event) => navigateTabs(event, index, selectTab)}
            className={`relative flex min-h-11 shrink-0 items-center gap-1.5 px-3 text-[12px] font-medium focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent ${active ? "text-text" : "text-text-faint hover:text-text-muted"}`}
          >
            <Icon weight={active ? "bold" : "regular"} className="text-[14px]" />
            {tab.label}
            {active ? <span className="absolute inset-x-2 bottom-0 h-0.5 bg-accent" /> : null}
          </button>;
        })}
      </nav>

      <main id={`task-panel-${activeTab}`} role="tabpanel" aria-labelledby={`task-tab-${activeTab}`} className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <div className="mx-auto w-full max-w-[96rem]">
          {activeTab === "overview" ? <TaskOverviewTab task={task} />
            : activeTab === "dispatch" ? <TaskDispatchTab task={task} focusedSessionId={focusedSessionId} />
              : activeTab === "evidence" ? <TaskEvidenceTab task={task} tasks={tasks} relations={relations} decisions={decisions} onNavigateEntity={onNavigateEntity} />
                : activeTab === "relations" ? <TaskRelationsTab task={task} tasks={tasks} relations={relations} decisions={decisions} onSelect={onSelect} onNavigateDecision={onNavigateDecision} onNavigateEntity={onNavigateEntity} onOpenSession={openSession} />
                  : activeTab === "closeout" ? <TaskCloseoutTab task={task} mutationFeedback={mutationFeedback} onProgress={onProgress} onSubmit={onSubmit} />
                    : <TaskFilesTab task={task} />}
        </div>
      </main>
    </div>
  );
}

function IdentityItem({ label, value, detail, wide = false, onClick }: { readonly label: string; readonly value: string; readonly detail?: React.ReactNode; readonly wide?: boolean; readonly onClick?: () => void }) {
  return (
    <div className={`min-w-0 border-r border-b border-border/70 px-4 py-3 2xl:border-b-0 ${wide ? "sm:col-span-2" : ""}`}>
      <dt className="font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-text-faint">{label}</dt>
      <dd title={value} className="mt-1 min-w-0 truncate font-mono text-[11px] text-text-muted">
        {onClick ? <button type="button" onClick={onClick} className="text-accent hover:underline">{value}</button> : value}
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

import type { TaskRow, Project, EventEntry, SnapshotStatus } from "../model/types.ts";
import type { TaskFilters } from "../model/taskFilters.ts";
import type { LaneGroupBy } from "../views/SwimlaneBoard.tsx";
import type { TriadicRendererData } from "../triadic-data.ts";
import { MOCK_PRESETS, MOCK_ADAPTERS } from "../model/mock.ts";
import { VIEW_LABEL, type ViewId } from "../shell-config.tsx";
import { HomeView } from "../views/HomeView.tsx";
import { OverviewView } from "../views/OverviewView.tsx";
import { BoardView } from "../views/BoardView.tsx";
import { DecisionsView } from "../views/DecisionsView.tsx";
import { DecisionPoolView } from "../views/DecisionPoolView.tsx";
import { FactTriageView } from "../views/FactTriageView.tsx";
import { ExecutionEvidenceView } from "../views/ExecutionEvidenceView.tsx";
import { GraphView } from "../views/GraphView.tsx";
import { GenealogyTimelineView } from "../views/GenealogyTimelineView.tsx";
import { PresetsView } from "../views/PresetsView.tsx";
import { AdaptersView } from "../views/AdaptersView.tsx";
import { SettingsView } from "../views/SettingsView.tsx";
import { TaskDetailView } from "../views/TaskDetailView.tsx";

type DrillState = { lane: string; status: SnapshotStatus; groupBy: LaneGroupBy } | null;

/**
 * 主内容区的视图路由:任务详情(选中时优先)+ 多视图切换条 + 视图表。
 *
 * 从 App.tsx 抽出(历史栈任务的前置拆分)。选中任务时渲染 TaskDetailView;
 * 否则按当前 view 渲染对应视图。所有应用位置态与导航回调由 AppShell 注入。
 */
export interface ViewSwitchProps {
  view: ViewId;
  selected: TaskRow | null;
  filteredProjectTasks: TaskRow[];
  taskFilters: TaskFilters;
  drill: DrillState;
  focusedEntityRef: string | null;
  project: Project;
  projectTasks: TaskRow[];
  tasks: TaskRow[];
  triadic: Pick<TriadicRendererData, "decisions" | "facts" | "relations" | "coverageRows" | "factAnchors">;
  favorites: Set<string>;
  events: EventEntry[];
  projectName: string;
  goto: (v: ViewId) => void;
  onMultiViewSwitch: (v: ViewId) => void;
  onOpenTaskPreview: (id: string) => void;
  onDrillToBoard: (lane: string, status: SnapshotStatus, dimension: "root" | "module") => void;
  onUpdateTask: (id: string, patch: Partial<TaskRow>) => void;
  onSelectTask: (id: string) => void;
  /** TaskDetailView 的「返回上一层」:清空选中态(回到视图表)。 */
  onClearSelection: () => void;
  onNavigateEntity: (ref: string) => void;
  onNavigateDecision: (decisionId: string) => void;
  onNavigateTask: (taskId: string) => void;
  onFocusEntityInGraph: (ref: string) => void;
  onFiltersChange: (filters: TaskFilters) => void;
  onToggleFavorite: (taskId: string) => void;
  onOpenProject: () => void;
}

export function ViewSwitch(props: ViewSwitchProps) {
  const {
    view,
    selected,
    filteredProjectTasks,
    taskFilters,
    drill,
    focusedEntityRef,
    project,
    projectTasks,
    tasks,
    triadic,
    favorites,
    events,
    projectName,
    goto,
    onMultiViewSwitch,
    onOpenTaskPreview,
    onDrillToBoard,
    onUpdateTask,
    onSelectTask,
    onClearSelection,
    onNavigateEntity,
    onNavigateDecision,
    onNavigateTask,
    onFocusEntityInGraph,
    onFiltersChange,
    onToggleFavorite,
    onOpenProject,
  } = props;

  const { decisions, facts, relations, coverageRows, factAnchors } = triadic;

  return (
    <>
      {!selected && (
        <div
          data-testid="multi-view-switcher"
          className="flex items-center gap-2 border-b border-border bg-surface/60 px-4 py-1.5"
        >
          <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
            多视图
          </span>
          <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
            {([
              { id: "graph", label: "关系图" },
              { id: "genealogy", label: "演化史" },
            ] as const).map((item) => (
              <button
                key={item.id}
                onClick={() => onMultiViewSwitch(item.id)}
                className={`rounded px-2 py-0.5 text-[12px] ${
                  view === item.id
                    ? "bg-surface-raised font-medium text-text"
                    : "text-text-muted hover:text-text"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-text-faint">
            常驻切换 · 关系图看结构,演化史看 decision 谱系随时间的 refine/narrow/supersede
          </span>
        </div>
      )}
      {selected ? (
        <TaskDetailView
          task={selected}
          tasks={tasks}
          relations={relations}
          decisions={decisions}
          onBack={onClearSelection}
          onUpdate={onUpdateTask}
          onSelect={onSelectTask}
          projectName={projectName}
          fromViewLabel={VIEW_LABEL[view]}
          onNavigateDecision={onNavigateDecision}
          onNavigateEntity={onNavigateEntity}
        />
      ) : view === "home" ? (
        <HomeView
          projects={[project]}
          tasks={tasks}
          events={events}
          currentProjectId={project.id}
          onOpenProject={onOpenProject}
        />
      ) : view === "overview" ? (
        <OverviewView
          project={project}
          tasks={projectTasks}
          decisions={decisions}
          facts={facts}
          relations={relations}
          onSelect={onOpenTaskPreview}
          onDrill={onDrillToBoard}
          onOpenInbox={() => goto("decisions")}
          onOpenDecisionPool={() => goto("decisionPool")}
        />
      ) : view === "board" ? (
        <BoardView
          tasks={filteredProjectTasks}
          allTasks={projectTasks}
          filters={taskFilters}
          onFiltersChange={onFiltersChange}
          onSelect={onOpenTaskPreview}
          onUpdate={onUpdateTask}
          drill={drill}
          relations={relations}
          favorites={favorites}
          onToggleFavorite={onToggleFavorite}
        />
      ) : view === "graph" ? (
        <GraphView
          tasks={projectTasks}
          relations={relations}
          decisions={decisions}
          facts={facts}
          coverageRows={coverageRows}
          factAnchors={factAnchors}
          onNavigateEntity={onNavigateEntity}
          focusRef={focusedEntityRef}
        />
      ) : view === "genealogy" ? (
        <GenealogyTimelineView
          decisions={decisions}
          relations={relations}
          focusRef={focusedEntityRef}
          onNavigateEntity={onNavigateEntity}
          onFocusGraph={onFocusEntityInGraph}
        />
      ) : view === "factTriage" ? (
        <FactTriageView
          facts={facts}
          relations={relations}
          decisions={decisions}
          tasks={tasks}
          coverageRows={coverageRows}
          factAnchors={factAnchors}
          onNavigateDecision={onNavigateDecision}
          onNavigateTask={onNavigateTask}
          focusedFactRef={
            focusedEntityRef?.startsWith("fact/") ? focusedEntityRef : null
          }
          onFocusGraph={onFocusEntityInGraph}
        />
      ) : view === "executions" ? (
        <ExecutionEvidenceView />
      ) : view === "decisions" ? (
        <DecisionsView
          decisions={decisions}
          tasks={tasks}
          relations={relations}
          facts={facts}
          onTraceSession={(sid) => {
            // 原型占位：真实由 coordinator 内置 conversation-mining 导出该 session 原文（E47）
            console.log("[prototype] trace session:", sid);
          }}
          onDecide={() => undefined}
          readOnly
          onNavigateDecision={onNavigateDecision}
          onNavigateTask={onNavigateTask}
          onFocusGraph={onFocusEntityInGraph}
          coverageRows={coverageRows}
        />
      ) : view === "decisionPool" ? (
        <DecisionPoolView
          decisions={decisions}
          facts={facts}
          relations={relations}
          focusedDecisionId={
            focusedEntityRef?.startsWith("decision/")
              ? focusedEntityRef.split("/")[1]
              : null
          }
          onFocusGraph={onFocusEntityInGraph}
        />
      ) : view === "presets" ? (
        <PresetsView presets={MOCK_PRESETS} project={project} />
      ) : view === "adapters" ? (
        <AdaptersView adapters={MOCK_ADAPTERS} tasks={projectTasks} />
      ) : (
        <SettingsView />
      )}
    </>
  );
}

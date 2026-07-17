import type { TaskRow, Project, EventEntry, SnapshotStatus } from "../model/types.ts";
import type { EntityHit } from "../model/entitySearch";
import type { TaskFilters } from "../model/taskFilters.ts";
import type { LaneGroupBy } from "../views/SwimlaneBoard.tsx";
import { useDecideMutation, type DecideAction, type TriadicRendererData } from "../triadic-data.ts";
import type { CatalogRendererData } from "../catalog-data.ts";
import { VIEW_LABEL, type ViewId } from "../shell-config.tsx";
import { HomeView } from "../views/HomeView.tsx";
import { OverviewView } from "../views/OverviewView.tsx";
import { BoardView } from "../views/BoardView.tsx";
import { DecisionsView } from "../views/DecisionsView.tsx";
import { DecisionPoolView } from "../views/DecisionPoolView.tsx";
import { FactTriageView } from "../views/FactTriageView.tsx";
import { ExecutionEvidenceView } from "../views/ExecutionEvidenceView.tsx";
import { PresetsView } from "../views/PresetsView.tsx";
import { AdaptersView } from "../views/AdaptersView.tsx";
import { SettingsView } from "../views/SettingsView.tsx";
import { TaskDetailView } from "../views/TaskDetailView.tsx";
import { EntityWorkspace } from "./EntityWorkspace.tsx";
import type { EntityFacet } from "../navigation/navigationHistory.ts";
import { useToast } from "./MutationToast.tsx";
import { t } from "../i18n/index.tsx";

type DrillState = { lane: string; status: SnapshotStatus; groupBy: LaneGroupBy } | null;

/**
 * 主内容区的视图路由:任务详情(选中时优先)+ 视图表。
 *
 * 从 App.tsx 抽出(历史栈任务的前置拆分)。选中任务时渲染 TaskDetailView;
 * 否则按当前 view 渲染对应视图。所有应用位置态与导航回调由 AppShell 注入。
 *
 * 关系图 vs 演化史:原顶栏常驻条(整页挂「关系图|演化史」跳转)已删 —— 现在演化史是
 * EntityWorkspace 里 decision 的一个 facet(G3 §③),不是独立 ViewId。非 graph 页面
 * 不再无脑顶一条多视图条。
 */
export interface ViewSwitchProps {
  view: ViewId;
  selected: TaskRow | null;
  filteredProjectTasks: TaskRow[];
  taskFilters: TaskFilters;
  drill: DrillState;
  focusedEntityRef: string | null;
  entityFacet: EntityFacet | null;
  project: Project;
  catalog: CatalogRendererData | undefined;
  catalogLoading: boolean;
  catalogError: boolean;
  projectTasks: TaskRow[];
  tasks: TaskRow[];
  triadic: Pick<TriadicRendererData, "decisions" | "facts" | "relations" | "coverageRows" | "factAnchors">;
  favorites: Set<string>;
  events: EventEntry[];
  projectName: string;
  goto: (v: ViewId) => void;
  onOpenTaskPreview: (id: string) => void;
  onDrillToBoard: (lane: string, status: SnapshotStatus, dimension: "root" | "module") => void;
  onUpdateTask: (id: string, patch: Partial<TaskRow>) => void;
  onSelectTask: (id: string) => void;
  /** TaskDetailView 的「返回上一层」:清空选中态(回到视图表)。 */
  onClearSelection: () => void;
  onNavigateEntity: (ref: string) => void;
  onNavigateDecision: (decisionId: string) => void;
  onNavigateTask: (taskId: string) => void;
  /** 实体工作台内焦点变更(画布双击 / 谱系侧栏点选) → 写回 AppLocation.focusedEntityRef。 */
  onFocusEntityChange: (ref: string | null) => void;
  /** 实体工作台 facet 切换(Graph ↔ Genealogy) → 写回 AppLocation.entityFacet。 */
  onEntityFacetChange: (facet: EntityFacet) => void;
  /** 跨视图「在关系图中聚焦」入口(从 Fact Triage / Decision Pool 等跳进 Graph facet)。 */
  onFocusEntityInGraph: (ref: string) => void;
  onFiltersChange: (filters: TaskFilters) => void;
  onToggleFavorite: (taskId: string) => void;
  projects: Project[];
  onOpenProject: (repoId?: string) => void;
  /** Cmd+K 派生的最近焦点,GraphView 左栏 Recent 直接消费。 */
  recentHits?: readonly EntityHit[];
  /** 用户点 GraphView 左栏「⌘K」触发器 → 打开全局命令面板。 */
  onOpenPalette?: () => void;
  /** 从决策池把 proposed 决策送入批准队列并聚焦(P3-2)。 */
  onOpenApproval?: (decisionId: string) => void;
}

export function ViewSwitch(props: ViewSwitchProps) {
  const {
    view,
    selected,
    filteredProjectTasks,
    taskFilters,
    drill,
    focusedEntityRef,
    entityFacet,
    project,
    catalog,
    catalogLoading,
    catalogError,
    projectTasks,
    tasks,
    triadic,
    favorites,
    events,
    projectName,
    goto,
    onOpenTaskPreview,
    onDrillToBoard,
    onUpdateTask,
    onSelectTask,
    onClearSelection,
    onNavigateEntity,
    onNavigateDecision,
    onNavigateTask,
    onFocusEntityChange,
    onEntityFacetChange,
    onFocusEntityInGraph,
    onFiltersChange,
    onToggleFavorite,
    projects,
    onOpenProject,
    recentHits,
    onOpenPalette,
    onOpenApproval,
  } = props;

  const { decisions, facts, relations, coverageRows, factAnchors } = triadic;
  const showToast = useToast();
  // Route decision mutations through the active project/repo selection.
  const decideMutation = useDecideMutation(project.id);

  const handleDecide = (id: string, action: DecideAction, rationale?: string) => {
    // Authority act: call the existing renderer API only. Principal is derived
    // by the daemon from the unix-socket owner — never inject actor fields here.
    decideMutation.mutate(
      { decisionId: id, action, judgmentOnlyRationale: rationale },
      {
        onSuccess: () => {
          const label =
            action === "accept"
              ? t("renderer.mutation.decisionAccepted")
              : action === "reject"
                ? t("renderer.mutation.decisionRejected")
                : t("renderer.mutation.decisionDeferred");
          showToast(`${label}: ${id}`, "success");
        },
        onError: (error: Error) => {
          showToast(
            t("renderer.mutation.decisionMutationFailed", {
              action,
              error: error.message,
            }),
            "error",
          );
        },
      },
    );
  };

  const handleCallAgent = (cmd: string) => {
    // CLI-bridge stub: copy the prefilled harness command so the human can
    // paste it into a terminal. Approval authority stays with the human.
    void navigator.clipboard?.writeText(cmd).then(
      () => showToast(t("renderer.mutation.agentCommandCopied"), "success"),
      () => showToast(t("renderer.mutation.agentCommandCopyFailed", { cmd }), "error"),
    );
  };

  return (
    <>
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
          projects={projects}
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
        <EntityWorkspace
          focusedEntityRef={focusedEntityRef}
          entityFacet={entityFacet}
          tasks={projectTasks}
          relations={relations}
          decisions={decisions}
          facts={facts}
          coverageRows={coverageRows}
          factAnchors={factAnchors}
          onNavigateEntity={onNavigateEntity}
          onFacetChange={onEntityFacetChange}
          onFocusEntityChange={onFocusEntityChange}
          recentHits={recentHits}
          onOpenPalette={onOpenPalette}
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
          onTraceSession={() => {
            // coordinator conversation-mining 导出(E47)尚未经 IPC 暴露。
            // 保留 callback 签名以免 DecisionsView 改型,实际为 noop。
          }}
          onDecide={handleDecide}
          onCallAgent={handleCallAgent}
          onNavigateDecision={onNavigateDecision}
          onNavigateTask={onNavigateTask}
          onFocusGraph={onFocusEntityInGraph}
          coverageRows={coverageRows}
          focusedDecisionId={
            focusedEntityRef?.startsWith("decision/")
              ? focusedEntityRef.split("/")[1]
              : null
          }
        />
      ) : view === "decisionPool" ? (
        <DecisionPoolView
          decisions={decisions}
          facts={facts}
          relations={relations}
          tasks={tasks}
          focusedDecisionId={
            focusedEntityRef?.startsWith("decision/")
              ? focusedEntityRef.split("/")[1]
              : null
          }
          onFocusGraph={onFocusEntityInGraph}
          onNavigateEntity={onNavigateEntity}
          onOpenApproval={onOpenApproval}
        />
      ) : view === "presets" ? (
        <PresetsView
          catalog={catalog}
          project={project}
          loading={catalogLoading}
          failed={catalogError}
        />
      ) : view === "adapters" ? (
        <AdaptersView
          adapters={catalog?.adapters ?? []}
          tasks={projectTasks}
          loading={catalogLoading}
          failed={catalogError}
        />
      ) : (
        <SettingsView />
      )}
    </>
  );
}

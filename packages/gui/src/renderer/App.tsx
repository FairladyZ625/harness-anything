import { useEffect, useMemo, useState } from "react";
import {
  Kanban,
  FolderSimple,
  SquaresFour,
  Graph,
  Scales,
  Stack,
  PlugsConnected,
  GearSix,
  CaretUpDown,
  CloudSlash,
  WarningCircle,
  GitBranch,
  FirstAidKit,
  ClockCounterClockwise,
} from "@phosphor-icons/react";
import type { SnapshotStatus } from "./model/types.ts";
import {
  MOCK_PRESETS,
  MOCK_ADAPTERS,
  MOCK_EVENTS,
} from "./model/mock.ts";
import { ThemeProvider } from "./theme.tsx";
import { HomeView } from "./views/HomeView.tsx";
import { OverviewView } from "./views/OverviewView.tsx";
import { BoardView } from "./views/BoardView.tsx";
import { DecisionsView } from "./views/DecisionsView.tsx";
import { DecisionPoolView } from "./views/DecisionPoolView.tsx";
import { FactTriageView } from "./views/FactTriageView.tsx";
import { GraphView } from "./views/GraphView.tsx";
import { GenealogyTimelineView } from "./views/GenealogyTimelineView.tsx";
import { PresetsView } from "./views/PresetsView.tsx";
import { AdaptersView } from "./views/AdaptersView.tsx";
import { SettingsView } from "./views/SettingsView.tsx";
import { TaskDetailView } from "./views/TaskDetailView.tsx";
import { TaskPreviewDrawer } from "./components/TaskPreviewDrawer.tsx";
import { ThemeToggle, NavButton, ProjectSummary, MockViewBanner } from "./components/shell-chrome.tsx";
import {
  DEFAULT_TASK_FILTERS,
  applyTaskFilters,
  type TaskFilters,
} from "./model/taskFilters.ts";
import { adaptProjectionRows, buildRealProject } from "./task-adapter.ts";
import { useTasksQuery, useSetTaskStatusMutation } from "./task-data.ts";
import { useTriadicProjectionQuery } from "./triadic-data.ts";
import { useFavorites } from "./model/favorites.ts";
import type { LaneGroupBy } from "./views/SwimlaneBoard.tsx";

type ViewId =
  | "home"
  | "overview"
  | "board"
  | "decisions"
  | "decisionPool"
  | "factTriage"
  | "graph"
  | "genealogy"
  | "presets"
  | "adapters"
  | "settings";

// 这些视图的数据仍为 mock:preset/adapter 管理面无真实后端。进入时顶部显式挂 MOCK 横幅。
const MOCK_BACKED_VIEWS: ReadonlySet<ViewId> = new Set([
  "home",
  "presets",
  "adapters",
]);

// W2C:列表并入看板(第三种 layout),独立「列表」入口删除。
const WORKSPACE_NAV: { id: ViewId; label: string; icon: React.ReactNode }[] = [
  { id: "overview", label: "总览", icon: <SquaresFour weight="duotone" /> },
  { id: "board", label: "看板", icon: <Kanban weight="duotone" /> },
  { id: "decisions", label: "决策批准", icon: <Scales weight="duotone" /> },
  { id: "decisionPool", label: "决策池", icon: <GitBranch weight="duotone" /> },
  { id: "factTriage", label: "事实分诊", icon: <FirstAidKit weight="duotone" /> },
  { id: "graph", label: "关系图", icon: <Graph weight="duotone" /> },
  { id: "genealogy", label: "演化史", icon: <ClockCounterClockwise weight="duotone" /> },
];

const MANAGE_NAV: { id: ViewId; label: string; icon: React.ReactNode }[] = [
  { id: "presets", label: "Preset / Vertical", icon: <Stack weight="duotone" /> },
  { id: "adapters", label: "引擎 Adapter", icon: <PlugsConnected weight="duotone" /> },
  { id: "settings", label: "设置", icon: <GearSix weight="duotone" /> },
];

const VIEW_LABEL: Record<ViewId, string> = {
  home: "项目",
  overview: "总览",
  board: "看板",
  decisions: "决策批准",
  decisionPool: "决策池",
  factTriage: "事实分诊",
  graph: "关系图",
  genealogy: "演化史",
  presets: "Preset / Vertical",
  adapters: "引擎 Adapter",
  settings: "设置",
};

function AppShell() {
  const [view, setView] = useState<ViewId>("overview");
  const tasksQuery = useTasksQuery();
  const triadicQuery = useTriadicProjectionQuery();
  const realTasks = useMemo(
    () => adaptProjectionRows(tasksQuery.data?.tasks ?? []),
    [tasksQuery.data],
  );
  const [tasks, setTasks] = useState<import("./model/types.ts").TaskRow[]>([]);
  // 台账投影是权威真数据源;查询刷新时重播到本地态(拖拽等乐观更新为原型内交互)。
  useEffect(() => {
    setTasks(realTasks);
  }, [realTasks]);

  const project = useMemo(() => buildRealProject(realTasks), [realTasks]);
  const projectId = project.id;
  const projects = useMemo(() => [project], [project]);
  const { favorites, toggleFavorite } = useFavorites(projectId);

  const decisions = triadicQuery.decisions;
  const facts = triadicQuery.facts;
  const relations = triadicQuery.relations;
  const coverageRows = triadicQuery.coverageRows;
  const factAnchors = triadicQuery.factAnchors;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [focusedEntityRef, setFocusedEntityRef] = useState<string | null>(null);
  const [taskFilters, setTaskFilters] =
    useState<TaskFilters>(DEFAULT_TASK_FILTERS);
  const [projectSwitcherOpen, setProjectSwitcherOpen] = useState(false);
  const [drill, setDrill] = useState<{
    lane: string;
    status: SnapshotStatus;
    groupBy: LaneGroupBy;
  } | null>(null);

  const projectTasks = useMemo(
    () => tasks.filter((t) => t.projectId === projectId),
    [tasks, projectId],
  );
  const projectEvents = useMemo(
    () => MOCK_EVENTS.filter((e) => e.projectId === projectId),
    [projectId],
  );

  const activeCount = projectTasks.filter(
    (t) => t.coordinationStatus === "active" || t.coordinationStatus === "blocked" || t.coordinationStatus === "in_review",
  ).length;

  const selected = useMemo(
    () => tasks.find((t) => t.taskId === selectedId) ?? null,
    [tasks, selectedId],
  );
  const previewTask = useMemo(
    () => tasks.find((t) => t.taskId === previewId) ?? null,
    [previewId, tasks],
  );
  const filteredProjectTasks = useMemo(
    () => applyTaskFilters(projectTasks, taskFilters, favorites),
    [projectTasks, taskFilters, favorites],
  );

  // 决策批准角标:proposed 决策数(唯一面向人的"待人处理"计数)
  const inboxCount = decisions.filter((d) => d.state === "proposed").length;

  // 状态写真桥:乐观更新本地态 + setTaskStatus 持久化(查询刷新时被权威投影覆盖)。
  const statusMutation = useSetTaskStatusMutation();
  const updateTask = (taskId: string, patch: Partial<import("./model/types.ts").TaskRow>) => {
    setTasks((prev) =>
      prev.map((t) => (t.taskId === taskId ? { ...t, ...patch } : t)),
    );
    if (patch.coordinationStatus && patch.coordinationStatus !== "unknown") {
      statusMutation.mutate({ taskId, status: patch.coordinationStatus });
    }
  };

  const goto = (v: ViewId) => {
    setView(v);
    setFocusedEntityRef(null);
    setSelectedId(null);
    setPreviewId(null);
    if (v !== "board") setDrill(null);
  };

  const openProject = () => {
    setTaskFilters(DEFAULT_TASK_FILTERS);
    setProjectSwitcherOpen(false);
    goto("overview");
  };

  const drillToBoard = (
    lane: string,
    status: SnapshotStatus,
    dimension: "root" | "module",
  ) => {
    // 特殊占位 __all__ 表示不锁定 lane(只 drill 到状态维度)
    const groupBy: LaneGroupBy = dimension === "root" ? "root" : "module";
    setDrill({ lane, status, groupBy });
    setView("board");
    setSelectedId(null);
    setPreviewId(null);
  };

  const openTaskPreview = (id: string) => {
    setSelectedId(null);
    setPreviewId(id);
  };

  const openTaskDetail = (id: string) => {
    setFocusedEntityRef(`task/${id}`);
    setPreviewId(null);
    setSelectedId(id);
  };

  // W2B 活链接:跨实体跳转(task→详情, decision→决策池, fact→事实分诊)
  const navigateToEntity = (ref: string) => {
    if (ref.startsWith("task/")) {
      const id = ref.slice(5).split("/")[0];
      openTaskDetail(id);
    } else if (ref.startsWith("decision/")) {
      const decisionId = ref.split("/")[1];
      setFocusedEntityRef(`decision/${decisionId}`);
      setView("decisionPool");
      setSelectedId(null);
      setPreviewId(null);
    } else if (ref.startsWith("fact/")) {
      setFocusedEntityRef(ref);
      setView("factTriage");
      setSelectedId(null);
      setPreviewId(null);
    }
  };
  const navigateToDecision = (decisionId: string) =>
    navigateToEntity(`decision/${decisionId}`);
  const navigateToTask = (taskId: string) => openTaskDetail(taskId);
  const focusEntityInGraph = (ref: string) => {
    setFocusedEntityRef(ref);
    setView("graph");
    setSelectedId(null);
    setPreviewId(null);
  };

  const showMockBanner = !selected && MOCK_BACKED_VIEWS.has(view);

  return (
    <div className="flex h-dvh flex-col overflow-hidden md:flex-row">
      <aside className="flex max-h-[42dvh] w-full shrink-0 flex-col overflow-y-auto border-b border-border bg-surface md:max-h-none md:w-56 md:overflow-visible md:border-r md:border-b-0">
        <div className="flex items-center gap-2 px-3 pt-3 pb-1">
          <span className="font-mono text-[11px] font-semibold tracking-wide text-text-muted">
            HARNESS
          </span>
          <span
            title="本地模式 · 未同步（V2：多端同步）"
            className="inline-flex items-center gap-1 rounded border border-border px-1 py-px font-mono text-[10px] text-text-faint"
          >
            <CloudSlash weight="bold" />
            本地
          </span>
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </div>

        <div className="px-3 pb-1">
          {tasksQuery.isSuccess ? (
            projectTasks.length > 0 ? (
              <span
                data-testid="real-task-summary"
                className="block font-mono text-[11px] text-text-faint"
              >
                Active work · {activeCount} of {projectTasks.length} tasks
              </span>
            ) : (
              <span
                data-testid="task-empty-state"
                className="block font-mono text-[11px] text-text-faint"
              >
                No task rows available from the local task bridge
              </span>
            )
          ) : tasksQuery.isError ? (
            <span className="block font-mono text-[11px] text-status-blocked">
              台账桥读取失败
            </span>
          ) : (
            <span className="block font-mono text-[11px] text-text-faint">
              读取本地台账…
            </span>
          )}
        </div>

        <div className="px-3 pt-2 pb-2">
          <div className="relative">
            <button
              onClick={() => setProjectSwitcherOpen((open) => !open)}
              title="快速切换项目"
              className={`flex w-full items-center gap-2 rounded-md border px-2 py-2 text-left text-sm font-medium hover:border-border-strong ${
                projectSwitcherOpen || view === "home"
                  ? "border-border-strong bg-surface-raised"
                  : "border-border bg-surface-raised"
              }`}
            >
              <FolderSimple weight="duotone" className="shrink-0 text-text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{project.name}</span>
                <span className="block truncate font-mono text-[11px] text-text-faint">
                  {project.preset}
                </span>
              </span>
              <CaretUpDown weight="bold" className="shrink-0 text-text-faint" />
            </button>

            {projectSwitcherOpen && (
              <div className="absolute left-0 right-0 z-30 mt-2 rounded-lg border border-border-strong bg-surface-raised p-2 shadow-2xl shadow-black/35 md:right-auto md:w-[320px]">
                <div className="flex items-center justify-between px-1 pb-2">
                  <span className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
                    快速切换
                  </span>
                  <span className="font-mono text-[11px] text-text-faint">
                    {projects.length} projects
                  </span>
                </div>
                <div className="flex max-h-[330px] flex-col gap-1.5 overflow-y-auto">
                  {projects.map((p) => (
                    <ProjectSummary
                      key={p.id}
                      project={p}
                      tasks={tasks}
                      active={p.id === projectId}
                      onOpen={openProject}
                    />
                  ))}
                </div>
                <div className="mt-2 grid grid-cols-2 gap-1.5 border-t border-border pt-2">
                  <button
                    onClick={() => {
                      setProjectSwitcherOpen(false);
                      goto("home");
                    }}
                    className="rounded-md border border-border px-2 py-1.5 text-left text-[12px] font-medium text-text-muted hover:border-border-strong hover:text-text"
                  >
                    管理全部
                  </button>
                  <button
                    disabled
                    className="inline-flex items-center justify-center gap-1 rounded-md border border-border px-2 py-1.5 text-[12px] text-text-faint opacity-70"
                  >
                    <WarningCircle weight="bold" />
                    本地模式
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="px-3 pt-1 pb-1 font-mono text-[12px] uppercase tracking-wide text-text-faint">
          工作区
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-1 md:flex-col md:gap-0.5 md:overflow-visible md:pb-0">
          {WORKSPACE_NAV.map((item) => (
            <NavButton
              key={item.id}
              active={view === item.id && !selected}
              onClick={() => goto(item.id)}
              icon={item.icon}
              label={item.label}
              badge={item.id === "decisions" ? inboxCount : undefined}
            />
          ))}
        </nav>

        <div className="px-3 pt-3 pb-1 font-mono text-[12px] uppercase tracking-wide text-text-faint">
          管理
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:gap-0.5 md:overflow-visible md:pb-0">
          {MANAGE_NAV.map((item) => (
            <NavButton
              key={item.id}
              active={view === item.id && !selected}
              onClick={() => goto(item.id)}
              icon={item.icon}
              label={item.label}
            />
          ))}
        </nav>

        <div className="mt-auto hidden border-t border-border px-3 py-2.5 md:block">
          <button
            disabled
            title="V2 预览：账号登录后可多设备同步、远程访问项目"
            className="flex w-full cursor-not-allowed items-center gap-2 text-left opacity-70"
          >
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-raised font-mono text-[11px] font-semibold text-text-muted">
              Z
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs text-text">本地模式</span>
              <span className="block truncate text-[10px] text-text-faint">
                账号与同步 · V2
              </span>
            </span>
          </button>
        </div>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {showMockBanner && <MockViewBanner />}
        <div className="flex min-h-0 min-w-0 flex-1 flex-row overflow-hidden">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {!selected && (view === "graph" || view === "genealogy") && (
              <div className="flex items-center gap-2 border-b border-border bg-surface/60 px-4 py-1.5">
                <span className="font-mono text-[10px] uppercase tracking-wide text-text-faint">
                  同一实体 · 多视图
                </span>
                <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
                  {([
                    { id: "graph", label: "关系图" },
                    { id: "genealogy", label: "演化史" },
                  ] as const).map((item) => (
                    <button
                      key={item.id}
                      onClick={() => setView(item.id)}
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
                  关系图看结构 · 演化史看 decision 谱系随时间的 refine/narrow/supersede
                </span>
              </div>
            )}
            {selected ? (
              <TaskDetailView
                task={selected}
                tasks={tasks}
                relations={relations}
                decisions={decisions}
                onBack={() => setSelectedId(null)}
                onUpdate={updateTask}
                onSelect={setSelectedId}
                projectName={project.name}
                fromViewLabel={VIEW_LABEL[view]}
                onNavigateDecision={navigateToDecision}
                onNavigateEntity={navigateToEntity}
              />
            ) : view === "home" ? (
              <HomeView
                projects={projects}
                tasks={tasks}
                events={MOCK_EVENTS}
                currentProjectId={projectId}
                onOpenProject={openProject}
              />
            ) : view === "overview" ? (
              <OverviewView
                project={project}
                tasks={projectTasks}
                decisions={decisions}
                facts={facts}
                relations={relations}
                onSelect={openTaskPreview}
                onDrill={drillToBoard}
                onOpenInbox={() => goto("decisions")}
                onOpenDecisionPool={() => goto("decisionPool")}
              />
            ) : view === "board" ? (
              <BoardView
                tasks={filteredProjectTasks}
                allTasks={projectTasks}
                filters={taskFilters}
                onFiltersChange={setTaskFilters}
                onSelect={openTaskPreview}
                onUpdate={updateTask}
                drill={drill}
                relations={relations}
                favorites={favorites}
                onToggleFavorite={toggleFavorite}
              />
            ) : view === "graph" ? (
              <GraphView
                tasks={projectTasks}
                relations={relations}
                decisions={decisions}
                facts={facts}
                coverageRows={coverageRows}
                factAnchors={factAnchors}
                onNavigateEntity={navigateToEntity}
                focusRef={focusedEntityRef}
              />
            ) : view === "genealogy" ? (
              <GenealogyTimelineView
                decisions={decisions}
                relations={relations}
                focusRef={focusedEntityRef}
                onNavigateEntity={navigateToEntity}
                onFocusGraph={focusEntityInGraph}
              />
            ) : view === "factTriage" ? (
              <FactTriageView
                facts={facts}
                relations={relations}
                decisions={decisions}
                tasks={tasks}
                coverageRows={coverageRows}
                factAnchors={factAnchors}
                onNavigateDecision={navigateToDecision}
                onNavigateTask={navigateToTask}
                focusedFactRef={
                  focusedEntityRef?.startsWith("fact/") ? focusedEntityRef : null
                }
                onFocusGraph={focusEntityInGraph}
              />
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
                onNavigateDecision={navigateToDecision}
                onNavigateTask={navigateToTask}
                onFocusGraph={focusEntityInGraph}
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
                onFocusGraph={focusEntityInGraph}
              />
            ) : view === "presets" ? (
              <PresetsView presets={MOCK_PRESETS} project={project} />
            ) : view === "adapters" ? (
              <AdaptersView adapters={MOCK_ADAPTERS} tasks={projectTasks} />
            ) : (
              <SettingsView />
            )}
          </div>
        </div>
      </main>
      <TaskPreviewDrawer
        task={previewTask}
        tasks={projectTasks}
        relations={relations}
        events={projectEvents}
        onClose={() => setPreviewId(null)}
        onOpenDetail={openTaskDetail}
        onPreviewTask={openTaskPreview}
      />
    </div>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <AppShell />
    </ThemeProvider>
  );
}

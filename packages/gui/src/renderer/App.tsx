import { useEffect, useMemo, useState } from "react";
import type { SnapshotStatus } from "./model/types.ts";
import { MOCK_EVENTS } from "./model/mock.ts";
import { ThemeProvider } from "./theme.tsx";
import { TaskPreviewDrawer } from "./components/TaskPreviewDrawer.tsx";
import { MockViewBanner } from "./components/shell-chrome.tsx";
import { AppSidebar } from "./components/AppSidebar.tsx";
import { ViewSwitch } from "./components/ViewSwitch.tsx";
import { NavigationHistoryBar } from "./components/NavigationHistoryBar.tsx";
import {
  DEFAULT_TASK_FILTERS,
  applyTaskFilters,
  type TaskFilters,
} from "./model/taskFilters.ts";
import type { LaneGroupBy } from "./views/SwimlaneBoard.tsx";
import { adaptProjectionRows, buildRealProject } from "./task-adapter.ts";
import { useTasksQuery, useSetTaskStatusMutation } from "./task-data.ts";
import { useTriadicProjectionQuery } from "./triadic-data.ts";
import { useFavorites } from "./model/favorites.ts";
import { MOCK_BACKED_VIEWS, type ViewId } from "./shell-config.tsx";
import { useNavigationHistory } from "./navigation/useNavigationHistory.ts";

function AppShell() {
  // 应用位置由导航历史栈持有:entries[index] 是唯一真源。
  // 六个位置状态(view/selectedId/previewId/focusedEntityRef/taskFilters/drill)
  // 全部从 location 派生,变更只走 navigate() / updateLocation() —— 这是
  // 「所有导航都进历史栈」的结构性保证(没有独立 setter 可绕过)。
  const {
    location,
    navigate,
    updateLocation,
    back,
    forward,
    canBack,
    canForward,
  } = useNavigationHistory({
    view: "overview",
    selectedId: null,
    previewId: null,
    focusedEntityRef: null,
    taskFilters: DEFAULT_TASK_FILTERS,
    drill: null,
  });

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
  const [projectSwitcherOpen, setProjectSwitcherOpen] = useState(false);

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
    () => tasks.find((t) => t.taskId === location.selectedId) ?? null,
    [tasks, location.selectedId],
  );
  const previewTask = useMemo(
    () => tasks.find((t) => t.taskId === location.previewId) ?? null,
    [location.previewId, tasks],
  );
  const filteredProjectTasks = useMemo(
    () => applyTaskFilters(projectTasks, location.taskFilters, favorites),
    [projectTasks, location.taskFilters, favorites],
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

  // ── 导航入口:全部汇流到 navigate() ──────────────────────────────
  // 原来有四个入口绕过了 goto 直接改 state(drillToBoard / navigateToEntity /
  // focusEntityInGraph / 多视图 switcher),历史栈会漏记。现在统一走 navigate。

  const goto = (v: ViewId) => {
    navigate({
      view: v,
      focusedEntityRef: null,
      selectedId: null,
      previewId: null,
      drill: v !== "board" ? null : location.drill,
    });
  };

  const openProject = () => {
    setProjectSwitcherOpen(false);
    navigate({
      view: "overview",
      focusedEntityRef: null,
      selectedId: null,
      previewId: null,
      drill: null,
      taskFilters: DEFAULT_TASK_FILTERS,
    });
  };

  const drillToBoard = (
    lane: string,
    status: SnapshotStatus,
    dimension: "root" | "module",
  ) => {
    // 特殊占位 __all__ 表示不锁定 lane(只 drill 到状态维度)
    const groupBy: LaneGroupBy = dimension === "root" ? "root" : "module";
    navigate({
      view: "board",
      drill: { lane, status, groupBy },
      selectedId: null,
      previewId: null,
    });
  };

  // 抽屉开关是「精修」不是「导航」——不推栈,但快照保留最新值。
  const openTaskPreview = (id: string) => {
    updateLocation({ selectedId: null, previewId: id });
  };

  const openTaskDetail = (id: string) => {
    navigate({ focusedEntityRef: `task/${id}`, previewId: null, selectedId: id });
  };

  // W2B 活链接:跨实体跳转(task→详情, decision→决策池, fact→事实分诊)
  const navigateToEntity = (ref: string) => {
    if (ref.startsWith("task/")) {
      const id = ref.slice(5).split("/")[0];
      openTaskDetail(id);
    } else if (ref.startsWith("decision/")) {
      const decisionId = ref.split("/")[1];
      navigate({
        focusedEntityRef: `decision/${decisionId}`,
        view: "decisionPool",
        selectedId: null,
        previewId: null,
      });
    } else if (ref.startsWith("fact/")) {
      navigate({
        focusedEntityRef: ref,
        view: "factTriage",
        selectedId: null,
        previewId: null,
      });
    }
  };
  const navigateToDecision = (decisionId: string) =>
    navigateToEntity(`decision/${decisionId}`);
  const navigateToTask = (taskId: string) => openTaskDetail(taskId);
  const focusEntityInGraph = (ref: string) => {
    navigate({
      focusedEntityRef: ref,
      view: "graph",
      selectedId: null,
      previewId: null,
    });
  };

  // 全局快捷键:Cmd+[ / Cmd+] (Mac) / Ctrl+[ / Ctrl+] (Win/Linux)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;
      if (event.key === "[") {
        event.preventDefault();
        back();
      } else if (event.key === "]") {
        event.preventDefault();
        forward();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [back, forward]);

  // 鼠标侧键:button 3 = 后退,button 4 = 前进(浏览器/Electron 惯例)
  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (event.button === 3) {
        back();
      } else if (event.button === 4) {
        forward();
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [back, forward]);

  const showMockBanner = !selected && MOCK_BACKED_VIEWS.has(location.view);

  return (
    <div className="flex h-dvh flex-col overflow-hidden md:flex-row">
      <AppSidebar
        view={location.view}
        selected={selected}
        tasksQuery={tasksQuery}
        projectTasks={projectTasks}
        activeCount={activeCount}
        project={project}
        projects={projects}
        projectId={projectId}
        tasks={tasks}
        projectSwitcherOpen={projectSwitcherOpen}
        onProjectSwitcherToggle={() => setProjectSwitcherOpen((open) => !open)}
        onManageAll={() => {
          setProjectSwitcherOpen(false);
          goto("home");
        }}
        openProject={openProject}
        goto={goto}
        inboxCount={inboxCount}
      />

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {showMockBanner && <MockViewBanner />}
        <NavigationHistoryBar
          canBack={canBack}
          canForward={canForward}
          onBack={back}
          onForward={forward}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-row overflow-hidden">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <ViewSwitch
              view={location.view}
              selected={selected}
              filteredProjectTasks={filteredProjectTasks}
              taskFilters={location.taskFilters}
              drill={location.drill}
              focusedEntityRef={location.focusedEntityRef}
              project={project}
              projectTasks={projectTasks}
              tasks={tasks}
              triadic={{ decisions, facts, relations, coverageRows, factAnchors }}
              favorites={favorites}
              events={MOCK_EVENTS}
              projectName={project.name}
              goto={goto}
              onMultiViewSwitch={(v: ViewId) => navigate({ view: v })}
              onOpenTaskPreview={openTaskPreview}
              onDrillToBoard={drillToBoard}
              onUpdateTask={updateTask}
              onSelectTask={(id: string) => navigate({ selectedId: id })}
              onClearSelection={() => navigate({ selectedId: null })}
              onNavigateEntity={navigateToEntity}
              onNavigateDecision={navigateToDecision}
              onNavigateTask={navigateToTask}
              onFocusEntityInGraph={focusEntityInGraph}
              onFiltersChange={(filters: TaskFilters) =>
                updateLocation({ taskFilters: filters })
              }
              onToggleFavorite={toggleFavorite}
              onOpenProject={openProject}
            />
          </div>
        </div>
      </main>
      <TaskPreviewDrawer
        task={previewTask}
        tasks={projectTasks}
        relations={relations}
        events={projectEvents}
        onClose={() => updateLocation({ previewId: null })}
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

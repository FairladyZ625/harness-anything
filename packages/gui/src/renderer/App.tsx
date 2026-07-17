import { useEffect, useMemo, useState } from "react";
import { isGenericStatusWriteTransition, type SnapshotStatus } from "./model/types.ts";
import { ThemeProvider } from "./theme.tsx";
import { TaskPreviewDrawer } from "./components/TaskPreviewDrawer.tsx";
import { MockViewBanner } from "./components/shell-chrome.tsx";
import { AppSidebar } from "./components/AppSidebar.tsx";
import { ViewSwitch } from "./components/ViewSwitch.tsx";
import { NavigationHistoryBar } from "./components/NavigationHistoryBar.tsx";
import { ToastProvider, useToast } from "./components/MutationToast.tsx";
import {
  DEFAULT_TASK_FILTERS,
  applyTaskFilters,
  type TaskFilters,
} from "./model/taskFilters.ts";
import type { LaneGroupBy } from "./views/SwimlaneBoard.tsx";
import { adaptProjectionRows, buildRealProject, REAL_PROJECT_ID } from "./task-adapter.ts";
import { useTasksQuery, useSetTaskStatusMutation } from "./task-data.ts";
import { useTriadicProjectionQuery } from "./triadic-data.ts";
import { useCatalogQuery } from "./catalog-data.ts";
import { useFavorites } from "./model/favorites.ts";
import { MOCK_BACKED_VIEWS, type ViewId } from "./shell-config.tsx";
import { useNavigationHistory } from "./navigation/useNavigationHistory.ts";
import type { EntityFacet } from "./navigation/navigationHistory.ts";
import { buildEntityIndex, type EntityHit } from "./model/entitySearch.ts";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { TerminalDock } from "./components/terminal/TerminalDock.tsx";
import { t, useI18n } from "./i18n/index.tsx";

const RECENT_LIMIT = 12;

function AppShell() {
  const { locale } = useI18n();
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
  } = useNavigationHistory(REAL_PROJECT_ID, {
    view: "overview",
    selectedId: null,
    previewId: null,
    focusedEntityRef: null,
    entityFacet: null,
    taskFilters: DEFAULT_TASK_FILTERS,
    drill: null,
  });

  const tasksQuery = useTasksQuery();
  const triadicQuery = useTriadicProjectionQuery();
  const catalogQuery = useCatalogQuery();
  // ROT-014: TanStack Query is the sole Task server-state owner.
  // Board/sidebar/selection read the adapted projection directly — no App useState mirror.
  const tasks = useMemo(
    () => adaptProjectionRows(tasksQuery.data?.tasks ?? []),
    [tasksQuery.data],
  );

  const project = useMemo(() => ({
    ...buildRealProject(tasks),
    preset: catalogQuery.data?.activePresetId ?? t("renderer.app.notConfigured"),
    engines: catalogQuery.data?.adapters.map((adapter) => adapter.engine) ?? ["local"]
  }), [catalogQuery.data, locale, tasks]);
  const projectId = project.id;
  const projects = useMemo(() => [project], [project]);
  const { favorites, toggleFavorite } = useFavorites(projectId);

  const decisions = triadicQuery.decisions;
  const facts = triadicQuery.facts;
  const relations = triadicQuery.relations;
  const coverageRows = triadicQuery.coverageRows;
  const factAnchors = triadicQuery.factAnchors;
  const [projectSwitcherOpen, setProjectSwitcherOpen] = useState(false);
  // Cmd+K 命令面板开态;Cmd+K / Ctrl+K 全局切换,面板内 Esc / Cmd+K 关闭。
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  // 最近焦点实体队列(用户在面板/画布/详情之间跳过哪些 navRef)。first = 最新。
  const [recentRefs, setRecentRefs] = useState<string[]>([]);

  const projectTasks = useMemo(
    () => tasks.filter((t) => t.projectId === projectId),
    [tasks, projectId],
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

  // 状态写真桥只提交普通 active/blocked 转换；权威投影成功刷新前不伪造本地状态。
  // 写操作统一走 toast 反馈:成功/失败都显式提示,不静默。
  const showToast = useToast();
  const statusMutation = useSetTaskStatusMutation();
  const updateTask = (taskId: string, patch: Partial<import("./model/types.ts").TaskRow>) => {
    const current = tasks.find((task) => task.taskId === taskId);
    if (
      current
      && patch.coordinationStatus
      && isGenericStatusWriteTransition(current.coordinationStatus, patch.coordinationStatus)
    ) {
      statusMutation.mutate(
        { taskId, status: patch.coordinationStatus },
        {
          onSuccess: () => showToast(t("renderer.mutation.taskStatusUpdated"), "success"),
          onError: (error: Error) =>
            showToast(t("renderer.mutation.taskStatusUpdateFailed", { error: error.message }), "error"),
        },
      );
    }
  };

  // ── 导航入口:全部汇流到 navigate() ──────────────────────────────
  // 原来有四个入口绕过了 goto 直接改 state(drillToBoard / navigateToEntity /
  // focusEntityInGraph / 多视图 switcher),历史栈会漏记。现在统一走 navigate。

  const goto = (v: ViewId) => {
    navigate({
      view: v,
      focusedEntityRef: null,
      entityFacet: null,
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
      entityFacet: null,
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
    navigate({ focusedEntityRef: `task/${id}`, entityFacet: null, previewId: null, selectedId: id });
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

  // P3-2: from decision pool, jump into the approval queue and focus that id.
  const openApproval = (decisionId: string) => {
    navigate({
      view: "decisions",
      focusedEntityRef: `decision/${decisionId}`,
      selectedId: null,
      previewId: null,
      entityFacet: null,
    });
  };

  // 实体工作台内部焦点变更(GraphView 双击 / Genealogy 侧栏点选)。
  // 不改 view,保留 entityFacet —— facet 切换走 setEntityFacet。
  // 持久化 ref 让 facet 切换(关系↔演化)能拿到正确焦点。
  const focusEntityInWorkspace = (ref: string | null) => {
    if (ref === null) {
      updateLocation({ focusedEntityRef: null });
      return;
    }
    // 把 ego byId key 翻译成 navRef:task 是裸 id,其他与 byId key 同形。
    const navRef = ref.includes("/") ? ref : `task/${ref}`;
    pushRecent(navRef);
    // 走 navigate 而非 updateLocation:焦点变更应推栈(用户「回到上一个焦点」)。
    // locationsEqual 防重复推同位置,useEgoCanvas 收到新 focusRef 再上游时也不会循环。
    navigate({ focusedEntityRef: navRef });
  };

  // 实体工作台 facet 切换(Graph ↔ Genealogy)。同一 focusedEntityRef 下切面,推栈
  // 让 Cmd+[ 能从「演化」回到「关系」。
  const setEntityFacet = (facet: EntityFacet) => {
    navigate({ entityFacet: facet });
  };

  // 跨视图「在关系图中聚焦」入口(Fact Triage / Decision Pool 等的「在关系图中看此实体」按钮)。
  // 跳进 Graph facet,默认 relations 面。
  const focusEntityInGraph = (ref: string) => {
    pushRecent(ref);
    navigate({
      focusedEntityRef: ref,
      view: "graph",
      entityFacet: "relations",
      selectedId: null,
      previewId: null,
    });
  };

  // Cmd+K 面板选中实体 = 关闭面板 + 走 focusEntityInGraph(满足 mission 「Enter → 图聚焦」)。
  const selectFromPalette = (ref: string) => {
    setPaletteOpen(false);
    focusEntityInGraph(ref);
  };

  // 把 navRef 推到 Recent 头部,去重 + 截 RECENT_LIMIT 个。
  // focusEntityInGraph / focusEntityInWorkspace / Cmd+K 选中都走这个,所以 Recent
  // 反映「用户真正打开过的实体」,不只是面板选中的。
  const pushRecent = (ref: string) => {
    setRecentRefs((prev) => {
      const next = [ref, ...prev.filter((r) => r !== ref)].slice(0, RECENT_LIMIT);
      return next;
    });
  };

  // 全局 Cmd+K / Ctrl+K:打开 / 关闭命令面板。Mac 走 metaKey,Win/Linux 走 ctrlKey。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.code === "Backquote") {
        event.preventDefault();
        setTerminalOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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

  // 三原语统一索引(权重排序)。Recent 反解从它查 by ref;GraphView 左栏 typeahead 也
  // 用同一口径(就地自建,因 entityIndex 不穿越 ViewSwitch/EntityWorkspace 下传)。
  // 单独 memo 让 recentRefs 变化时不必重建整张索引。
  const entityIndex = useMemo(
    () => buildEntityIndex({ tasks: projectTasks, decisions, facts }),
    [projectTasks, decisions, facts],
  );

  // Recent 列表:把 navRef 反解为 EntityHit(供 FocusSwitcher 显示标题/副标题)。
  // 从全局索引 by ref 查,这样 Recent 顺序与索引解析一致;索引外的 ref(已删除实体)自动过滤掉。
  const recentHits = useMemo<EntityHit[]>(() => {
    const byRef = new Map(entityIndex.map((h) => [h.ref, h]));
    const out: EntityHit[] = [];
    for (const ref of recentRefs) {
      const hit = byRef.get(ref);
      if (hit) out.push(hit);
      if (out.length >= RECENT_LIMIT) break;
    }
    return out;
  }, [entityIndex, recentRefs]);

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
              entityFacet={location.entityFacet}
              project={project}
              catalog={catalogQuery.data}
              catalogLoading={catalogQuery.isLoading}
              catalogError={catalogQuery.isError}
              projectTasks={projectTasks}
              tasks={tasks}
              triadic={{ decisions, facts, relations, coverageRows, factAnchors }}
              favorites={favorites}
              events={[]}
              projectName={project.name}
              goto={goto}
              onOpenTaskPreview={openTaskPreview}
              onDrillToBoard={drillToBoard}
              onUpdateTask={updateTask}
              onSelectTask={(id: string) => navigate({ selectedId: id })}
              onClearSelection={() => navigate({ selectedId: null })}
              onNavigateEntity={navigateToEntity}
              onNavigateDecision={navigateToDecision}
              onNavigateTask={navigateToTask}
              onFocusEntityChange={focusEntityInWorkspace}
              onEntityFacetChange={setEntityFacet}
              onFocusEntityInGraph={focusEntityInGraph}
              onFiltersChange={(filters: TaskFilters) =>
                updateLocation({ taskFilters: filters })
              }
              onToggleFavorite={toggleFavorite}
              onOpenProject={openProject}
              recentHits={recentHits}
              onOpenPalette={() => setPaletteOpen(true)}
              onOpenApproval={openApproval}
            />
          </div>
        </div>
        <TerminalDock
          open={terminalOpen}
          projectId={projectId}
          onToggle={() => setTerminalOpen((open) => !open)}
        />
      </main>
      <TaskPreviewDrawer
        task={previewTask}
        tasks={projectTasks}
        relations={relations}
        events={[]}
        onClose={() => updateLocation({ previewId: null })}
        onOpenDetail={openTaskDetail}
        onPreviewTask={openTaskPreview}
      />
      <CommandPalette
        open={paletteOpen}
        tasks={projectTasks}
        decisions={decisions}
        facts={facts}
        onClose={() => setPaletteOpen(false)}
        onSelectedRef={selectFromPalette}
      />
    </div>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AppShell />
      </ToastProvider>
    </ThemeProvider>
  );
}

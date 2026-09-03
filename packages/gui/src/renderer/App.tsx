import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SnapshotStatus } from "./model/types.ts";
import { ThemeProvider } from "./theme.tsx";
import { HomeView } from "./views/HomeView.tsx";
import { OverviewView } from "./views/OverviewView.tsx";
import { BoardView } from "./views/BoardView.tsx";
import { DecisionsView } from "./views/DecisionsView.tsx";
import { DecisionPoolView } from "./views/DecisionPoolView.tsx";
import { FactDetailView } from "./views/EntityDetailView.tsx";
import { DecisionDetailView } from "./components/decisionDetail/DecisionDetailView.tsx";
import { FreshnessView } from "./views/FreshnessView.tsx";
import { EntityWorkspace } from "./components/EntityWorkspace.tsx";
import { PresetsView } from "./views/PresetsView.tsx";
import { EntitiesView } from "./views/EntitiesView.tsx";
import { AdaptersView } from "./views/AdaptersView.tsx";
import { SettingsView } from "./views/SettingsView.tsx";
import { SystemView } from "./views/SystemView.tsx";
import { DaemonObserveView } from "./views/DaemonObserveView.tsx";
import { TaskDetailView } from "./views/TaskDetailView.tsx";
import { TaskPreviewDrawer } from "./components/TaskPreviewDrawer.tsx";
import { AppSidebar } from "./components/AppSidebar.tsx";
import type { LedgerStatusBarInput } from "./components/sidebar/SystemStatusPanel.tsx";
import { CommandPalette, buildPaletteIndex } from "./components/CommandPalette.tsx";
import { useEntityNavigation } from "./navigation/useEntityNavigation.ts";
import { useAppShortcuts } from "./navigation/useAppShortcuts.ts";
import { applyTaskFilters, type TaskFilters } from "./model/taskFilters.ts";
import { adaptProjectionRows } from "./task-adapter.ts";
import { invalidateLedgerDependents, useTasksQuery } from "./task-data.ts";
import { useAgendaQuery } from "./agenda-data.ts";
import {
  useActiveEdgesQuery,
  useDecisionDerivesQuery,
  useDecisionSummaryQuery,
  usePaletteFactsQuery,
  useRuntimePlaneQuery,
  useTriadicProjectionQuery,
} from "./triadic-data.ts";
import { useFavorites } from "./model/favorites.ts";
import { deriveRuntimeHealth } from "./model/runtime-health.ts";
import type { LaneGroupBy } from "./views/SwimlaneBoard.tsx";
import { SessionsView } from "./views/SessionsView.tsx";
import { SchedulesView } from "./views/SchedulesView.tsx";
import { ArtifactsView } from "./views/ArtifactsView.tsx";
import { AgentSquadView } from "./views/AgentSquadView.tsx";
import { ProvidersView } from "./views/ProvidersView.tsx";
import { useTaskActions } from "./task-actions.ts";
import { useDecisionActions } from "./decision-actions.ts";
import { selectActiveRepoId, useSystemStatusQuery } from "./system-data.ts";
import { useCatalogSnapshot } from "./catalog-data.ts";
import { adaptRepoProject } from "./model/project-adapter.ts";
import { TerminalView, type TerminalLaunchTask } from "./views/TerminalView.tsx";
import { BrowserView } from "./views/BrowserView.tsx";
import { NavigationHistoryBar } from "./components/NavigationHistoryBar.tsx";
import { useViewHistory } from "./navigation/useViewHistory.ts";
import { useLocationRestore } from "./navigation/useLocationRestore.ts";
import { initialLocation, resetViewHistory } from "./navigation/viewHistoryStorage.ts";
import type { ViewId } from "./navigation/viewHistory.ts";
import { navLabel } from "./navigation/navConfig.tsx";
import { useWorkspaceSummaryQuery } from "./workspace-summary-data.ts";
import { WorkspaceSummaryPending } from "./components/WorkspaceSummaryPending.tsx";
import { prewarmRuntimeInstanceCatalog } from "./runtime-instance-data.ts";
import { FirstRunGuide } from "./components/FirstRunGuide.tsx";
import { LocalDocLayer } from "./local-doc/LocalDocLayer.tsx";
import { useLocalDocOpener } from "./local-doc/local-doc-context.ts";
import { useEntityKindOptions, useGovernedEntityRows } from "./entity-kind-data.ts";

/**
 * 渲染全量决策行的视图。总览不在决策抽屉关闭时预读完整图;
 * 其他集合内视图同时渲染图 + 决策。只有这些视图挂载时才读完整投影;
 * 看板/总览之外的普通页(presets/adapters/settings/system/…)与任务看板本身都不在其中。
 */
const FULL_TRIADIC_PROJECTION_VIEWS: ReadonlySet<ViewId> = new Set([
  "overview",
  "graph",
  "decisions",
  "decisionPool",
  "decisionDetail",
  "factDetail",
  "freshness",
]);

function AppShell() {
  const [activeRepoId, setActiveRepoId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const systemQuery = useSystemStatusQuery();
  const enabledRepos = useMemo(
    () => systemQuery.data?.repos.filter((repo) => repo.registrationState === "enabled") ?? [],
    [systemQuery.data?.repos],
  );
  useEffect(() => {
    const next = selectActiveRepoId(systemQuery.data?.repos ?? [], activeRepoId);
    if (next !== activeRepoId) setActiveRepoId(next);
  }, [activeRepoId, systemQuery.data?.repos]);
  const projectId = activeRepoId ?? "unselected";
  // 已注册 kind 清单(内核内建 + 本仓 vertical 声明):图筛选、命令面板与实体说明面同源于此。
  const entityKinds = useEntityKindOptions(projectId);
  const governedEntities = useGovernedEntityRows(projectId);
  const declaredKinds = useMemo(() => entityKinds.map(({ kind }) => kind), [entityKinds]);
  const tasksQuery = useTasksQuery(activeRepoId);
  const workspaceSummaryQuery = useWorkspaceSummaryQuery(activeRepoId);

  // 侧栏左下角系统运行区的第一行输入(原左上角状态栏,task_b2fb4bc7):
  // 全部来自上面两条既有查询,不加第二条读路。
  const ledgerReadError = [workspaceSummaryQuery.error, tasksQuery.error].find(
    (error): error is Error => error instanceof Error,
  );
  const ledgerStatusBar: LedgerStatusBarInput = {
    revision: tasksQuery.data?.sourceRevision ?? null,
    refreshedAgoSec:
      tasksQuery.dataUpdatedAt > 0 ? Math.max(0, Math.round((Date.now() - tasksQuery.dataUpdatedAt) / 1_000)) : null,
    connected: !tasksQuery.isRefetchError && !tasksQuery.isError && !workspaceSummaryQuery.isError,
    refreshing: tasksQuery.isFetching,
    empty: workspaceSummaryQuery.isSuccess === true && workspaceSummaryQuery.data.tasks.total === 0,
    error: workspaceSummaryQuery.isError || tasksQuery.isError ? (ledgerReadError?.message ?? "") : null,
  };
  const refreshLedger = useCallback(() => {
    void tasksQuery.refetch();
    void workspaceSummaryQuery.refetch();
  }, [tasksQuery, workspaceSummaryQuery]);
  const lastLedgerCut = useRef<string | null>(null);
  const catalogQuery = useCatalogSnapshot(activeRepoId);
  const taskActions = useTaskActions(projectId);
  const decisionActions = useDecisionActions(projectId);
  // 应用位置由视图导航历史栈持有(REQ-GUI-01):view/selectedId/previewId/
  // focusedEntityRef/taskFilters/drill 全部从 location 派生,变更走 navigate()
  // (推栈)或 updateLocation()(原地改)。与图内 FocusHistoryBar 并存:那是
  // 聚光灯的实体焦点微历史,这是跨视图的应用位置历史。
  // 它在三元读取之前解析:读哪个切面由「现在挂载的是哪个界面」决定。
  const { location, navigate, updateLocation, back, forward, canBack, canForward } = useViewHistory(
    projectId,
    initialLocation(),
  );
  // 回退保真(G10):导航栈恢复应用位置;这里在它旁边恢复 DOM 层的滚动与焦点。
  useLocationRestore(location, document.body);
  const { view, selectedId, previewId, focusedEntityRef, taskFilters, drill } = location;
  // 总览的「PIN 在做」直接消费 `ha agenda` 同一条 repo.agenda.read 投影。
  // 其他视图不挂载这条读,避免把已删除的独立议程页变成后台读取。
  const agendaQuery = useAgendaQuery(activeRepoId !== null && view === "overview" ? activeRepoId : null);
  const setTaskFilters = (next: TaskFilters) => updateLocation({ taskFilters: next });
  const [projectSwitcherOpen, setProjectSwitcherOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [overviewDecisionPreviewId, setOverviewDecisionPreviewId] = useState<string | null>(null);
  useEffect(() => {
    setOverviewDecisionPreviewId(null);
  }, [view, activeRepoId]);
  const [setupGuide, setSetupGuide] = useState<"provider" | "agent" | null>(null);

  // placement 不再由 renderer 二次推导:repo.tasks.list 的 row.placement 已带
  // daemon 侧由同一批 active derives 边算出的 moduleKeys/productLines/
  // spawningDecisionIds(F-84CF0391),所以任务行适配不再依赖任何三元读取。
  const tasks = useMemo(
    () => adaptProjectionRows(tasksQuery.data?.rows ?? [], projectId, tasksQuery.data?.status),
    [projectId, tasksQuery.data],
  );
  const activeRepo = systemQuery.data?.repos.find((repo) => repo.repoId === activeRepoId);
  const project = adaptRepoProject(
    projectId,
    activeRepo,
    catalogQuery.data?.defaults.presetId,
    tasks[0]?.lastKnownAt ?? systemQuery.data?.observedAt ?? new Date(0).toISOString(),
  );
  const { favorites, toggleFavorite } = useFavorites(projectId);
  // 终端链接(W2)的文档落点:本机文档预览浮层的既有打开入口,repo 相对路径在
  // TerminalView 侧解析成绝对路径后从这里进浮层,存在性由只读桥打开时校验。
  const { openLocalDocument } = useLocalDocOpener();

  const projectTasks = useMemo(() => tasks.filter((t) => t.projectId === projectId), [tasks, projectId]);
  /** task 详情「打开终端」→ 终端页进页即建绑定会话;requestId 让同一请求只消费一次。 */
  const [terminalLaunch, setTerminalLaunch] = useState<TerminalLaunchTask | null>(null);
  const selected = useMemo(() => tasks.find((t) => t.taskId === selectedId) ?? null, [tasks, selectedId]);
  const previewTask = useMemo(() => tasks.find((t) => t.taskId === previewId) ?? null, [previewId, tasks]);
  const filteredProjectTasks = useMemo(
    () => applyTaskFilters(projectTasks, taskFilters, favorites),
    [projectTasks, taskFilters, favorites],
  );

  // ----------------------------------------------------------------三元读取分层
  // 窄面也按真实消费者挂载:看板需要 derives 徽章,任务详情/⌘K 需要决策标题,
  // 其余页面不背景读它们。⌘K 的事实切面与完整投影同样由当前界面决定
  // (裁决 2026-08-29;fact F-9E166C6B:根级全量重取曾占 GUI 收到字节的 99.13%)。
  const fullProjectionMounted = FULL_TRIADIC_PROJECTION_VIEWS.has(view);
  const fullGraphProjectionMounted = fullProjectionMounted && view !== "overview";
  // 完整投影视图已经包含 decisions + derives 边,不再并发读两条窄面。总览新增
  // repo.agenda.read 后仍比旧冷加载少一个请求,并且没有缓存/第二投影。
  const decisionDerives = useDecisionDerivesQuery(activeRepoId, {
    enabled: !fullProjectionMounted && view === "board",
  });
  const decisionSummary = useDecisionSummaryQuery(activeRepoId, {
    enabled: !fullProjectionMounted && (selectedId !== null || paletteOpen),
  });
  const paletteFacts = usePaletteFactsQuery(activeRepoId, paletteOpen);
  const triadicQuery = useTriadicProjectionQuery(activeRepoId, {
    enabled: fullProjectionMounted,
    graphEnabled: fullGraphProjectionMounted,
  });
  // 运行时平面(agent/schedule 行 + agent→task 派发边):只有关系图页读;三条既有
  // 读(agent 目录/Schedule 列表/关系图切面)与各自入口共享缓存,不另立读方法。
  const graphRuntimeMounted = view === "graph";
  const runtimePlane = useRuntimePlaneQuery(activeRepoId, { enabled: graphRuntimeMounted });
  // 任务预览抽屉、任务详情与会话页渲染的是关系边本身;完整图已在缓存里(刚从图/
  // 决策视图过来)就直接用它,不把同一批边读两遍。
  const edgeSurfaceMounted =
    previewTask !== null || selected !== null || overviewDecisionPreviewId !== null || view === "sessions";
  const activeEdges = useActiveEdgesQuery(activeRepoId, edgeSurfaceMounted && !triadicQuery.graphAvailable);

  const decisions = triadicQuery.decisions;
  const facts = triadicQuery.facts;
  const coverageRows = triadicQuery.coverageRows;
  const factAnchors = triadicQuery.factAnchors;
  /** 完整投影视图用的关系集合:只在那些视图挂载时有值。 */
  const relations = triadicQuery.relations;
  /** 边级界面用的关系集合:完整图可用时是全量边,否则是 active 边切面。 */
  const edgeRelations = triadicQuery.graphAvailable ? triadicQuery.relations : activeEdges.relations;
  /** 看板/列表徽章用的关系集合:根级 derives 切面,任何视图下都在。 */
  const boardRelations = fullProjectionMounted ? relations : decisionDerives.relations;
  /** chrome 的决策标题/命令面板:完整投影在场就复用,否则用常驻窄面。 */
  const chromeDecisions = fullProjectionMounted ? decisions : decisionSummary.decisions;

  useEffect(() => {
    if (!activeRepoId || !tasksQuery.data) return;
    const cut = `${activeRepoId}:${tasksQuery.data.watermark}:${tasksQuery.data.sourceRevision}`;
    // 首次水合只是建立比较基准,不是「台账变化」。把它当变化会让刚完成的
    // workspace summary / 三元切面立刻再读一遍;后续 cut 才失效挂载中的读面。
    if (lastLedgerCut.current === null) {
      lastLedgerCut.current = cut;
      return;
    }
    if (lastLedgerCut.current === cut) return;
    lastLedgerCut.current = cut;
    void invalidateLedgerDependents(queryClient, activeRepoId);
  }, [activeRepoId, queryClient, tasksQuery.data?.sourceRevision, tasksQuery.data?.watermark]);

  useEffect(() => {
    if (!systemQuery.isSuccess || !tasksQuery.isSuccess) return;
    // Runtime installation discovery may execute provider version/model probes on its first read.
    // Start it only after the primary workspace is ready, then retain the result for Agent/Provider.
    void prewarmRuntimeInstanceCatalog(queryClient);
  }, [queryClient, systemQuery.isSuccess, tasksQuery.isSuccess]);

  // The badge is the daemon's canonical inbox count; renderer rows are not a second census.
  const inboxCount = workspaceSummaryQuery.data?.decisions.inboxCount;

  // 系统运行区输入(口径见 model/runtime-health.ts;原总览第四格,2026-08-31 收纳进
  // 侧栏后改为常驻派生):daemon 响应折算自 systemQuery 成败 + observedAt 年龄;
  // 投影落后取 tasksQuery 的同一对数字。读面不变,只是消费点从总览页移到外壳。
  const daemonReadFailed = systemQuery.isError;
  const runtimeHealth = useMemo(() => {
    const lastSnapshotAt = projectTasks.reduce(
      (latest, task) => (task.lastKnownAt > latest ? task.lastKnownAt : latest),
      "",
    );
    return deriveRuntimeHealth({
      daemon: systemQuery.data
        ? {
            ok: !systemQuery.isError,
            observedAt: systemQuery.data.observedAt,
            uptimeMs: systemQuery.data.daemon.uptimeMs,
          }
        : null,
      repo: activeRepo ?? null,
      projection: tasksQuery.data
        ? {
            watermark: tasksQuery.data.watermark,
            sourceRevision: tasksQuery.data.sourceRevision,
            status: tasksQuery.data.status,
          }
        : null,
      lastSnapshotAt: lastSnapshotAt || null,
      now: new Date().toISOString(),
    });
  }, [activeRepo, projectTasks, systemQuery.data, systemQuery.isError, tasksQuery.data]);

  const goto = (v: ViewId) => {
    navigate({
      view: v,
      focusedEntityRef: null,
      selectedId: null,
      previewId: null,
      ...(v !== "board" ? { drill: null } : {}),
    });
  };

  const openProject = async (repoId: string) => {
    if (repoId !== activeRepoId) {
      // 终端页(若挂载)随 goto("overview") 卸载,卸载清理自会停流并 detach 全部附件。
      if (activeRepoId) await queryClient.cancelQueries({ predicate: (query) => query.queryKey[1] === activeRepoId });
      // 新仓以干净初始栈打开(overview + 默认筛选);仓内 back/forward 仍持久化。
      resetViewHistory(window.sessionStorage, repoId);
      resetRecentRefs();
      setActiveRepoId(repoId);
    }
    setProjectSwitcherOpen(false);
    goto("overview");
  };

  const drillToBoard = (lane: string, status: SnapshotStatus, dimension: "root" | "module" | "plt") => {
    // 特殊占位 __all__ 表示不锁定 lane(只 drill 到状态维度)
    const groupBy: LaneGroupBy = dimension === "root" ? "root" : dimension === "module" ? "module" : "productLine";
    navigate({ drill: { lane, status, groupBy }, view: "board", selectedId: null, previewId: null });
  };

  // 实体导航出口(可寻址路由 + 最近访问)集中在此 hook;跨仓跳转先切仓再续导航。
  const {
    recentRefs,
    resetRecentRefs,
    openTaskPreview,
    openTaskDetail,
    navigateToEntity,
    navigateToDecision,
    navigateToTask,
    focusEntityInGraph,
    focusEntityInWorkspace,
    openDecisionInPool,
    selectRuntimeEntity,
  } = useEntityNavigation({
    navigate,
    updateLocation,
    activeRepoId,
    enabledRepoIds: enabledRepos.map((repo) => repo.repoId),
    openInRepo: (repoId, continueInRepo) => {
      void openProject(repoId).then(continueInRepo);
    },
    onRepoUnavailable: () => {
      navigate({ view: "home" });
      setProjectSwitcherOpen(true);
    },
    declaredKinds,
  });

  // ⌘K 命令面板(REQ-GUI-01):跨实体搜索 + 快速跳转。纯前端派生,不消费写 IPC。
  // 决策条目来自常驻的摘要投影,事实条目来自面板打开时才读的事实切面——面板合上
  // 时不持有任何三元投影。
  // 声明实体一并进搜索范围:索引按行喂,加一个 kind 不改这里的形参。
  const paletteEntries = useMemo(
    () =>
      buildPaletteIndex(
        projectTasks,
        chromeDecisions,
        paletteFacts.facts,
        governedEntities.map((entity) => ({
          ref: entity.ref,
          label: entity.title ?? entity.entityId,
          ...(entity.locator ? { sub: entity.locator.value } : {}),
          entity: entity.kind,
        })),
      ),
    [projectTasks, chromeDecisions, paletteFacts.facts, governedEntities],
  );

  useAppShortcuts({
    onTogglePalette: () => setPaletteOpen((open) => !open),
    // Ctrl+` = 终端页进出(PLT-TerminalWorkspace W0):不在终端页→压栈进入;
    // 在终端页→回上一视图(栈底无上一视图时回总览,保证快捷键总能离开)。
    onToggleTerminal: () => {
      if (view !== "terminal") goto("terminal");
      else if (canBack) back();
      else goto("overview");
    },
    onBack: back,
    onForward: forward,
  });

  useEffect(() => {
    if (!activeRepoId || !setupGuide) return;
    const destination = setupGuide === "provider" ? "providers" : "agentSquad";
    if (view !== destination)
      navigate({
        view: destination,
        focusedEntityRef: null,
        selectedId: null,
        previewId: null,
      });
  }, [activeRepoId, navigate, setupGuide, view]);

  // 首次运行并入 Settings → 仓库与连接(PLT-EdgeGUI-W3):无启用仓库时一次性把应用
  // 带到该页的「添加仓库/添加连接」空态,不再弹独立首次运行对话框。
  const landedOnEmptyState = useRef(false);
  useEffect(() => {
    if (!systemQuery.isSuccess || enabledRepos.length > 0 || landedOnEmptyState.current) return;
    landedOnEmptyState.current = true;
    if (view !== "settings") goto("settings");
  }, [enabledRepos.length, goto, systemQuery.isSuccess, view]);

  return (
    <LocalDocLayer mode={activeRepo?.mode ?? "local"}>
      <div className="flex h-dvh flex-col overflow-hidden md:flex-row">
        <AppSidebar
          project={project}
          repos={systemQuery.data?.repos ?? []}
          activeRepoId={activeRepoId}
          view={view}
          hasSelection={selected !== null}
          inboxCount={inboxCount}
          projectSwitcherOpen={projectSwitcherOpen}
          onProjectSwitcherToggle={() => setProjectSwitcherOpen((open) => !open)}
          onOpenProject={(repoId) => {
            void openProject(repoId);
          }}
          onOpenProjectManager={() => {
            setProjectSwitcherOpen(false);
            goto("home");
          }}
          onNavigate={goto}
          ledgerStatus={ledgerStatusBar}
          onRefreshLedger={refreshLedger}
          health={runtimeHealth}
          onOpenSystem={() => goto("system")}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <NavigationHistoryBar canBack={canBack} canForward={canForward} onBack={back} onForward={forward} />
          <div key={projectId} className="flex min-h-0 min-w-0 flex-1 flex-row overflow-hidden">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
              {selected ? (
                <TaskDetailView
                  task={selected}
                  tasks={tasks}
                  relations={edgeRelations}
                  decisions={chromeDecisions}
                  onBack={() => updateLocation({ selectedId: null })}
                  onSelect={(id) => updateLocation({ selectedId: id })}
                  projectName={project.name}
                  fromViewLabel={navLabel(view)}
                  onNavigateDecision={navigateToDecision}
                  onNavigateEntity={navigateToEntity}
                  mutationFeedback={taskActions.feedback.get(selected.taskId)}
                  onProgress={(input) => taskActions.appendProgress(selected, input)}
                  onSubmit={(submission) => taskActions.submitTask(selected, submission)}
                  onSetPin={(task, pinned) => {
                    void taskActions.setTaskPin(task, pinned);
                  }}
                  onOpenTerminal={(task) => {
                    setTerminalLaunch({ requestId: crypto.randomUUID(), taskId: task.taskId, title: task.title });
                    updateLocation({ selectedId: null });
                    goto("terminal");
                  }}
                  onFocusGraph={focusEntityInGraph}
                />
              ) : view === "home" ? (
                <HomeView
                  repos={systemQuery.data?.repos ?? []}
                  currentRepoId={activeRepoId}
                  onOpenProject={(repoId) => {
                    void openProject(repoId);
                  }}
                />
              ) : view === "overview" ? (
                workspaceSummaryQuery.data ? (
                  <OverviewView
                    project={project}
                    tasks={projectTasks}
                    agenda={agendaQuery.data}
                    decisions={decisions}
                    workspaceSummary={workspaceSummaryQuery.data}
                    relations={edgeRelations}
                    health={runtimeHealth}
                    daemonReadFailed={daemonReadFailed}
                    ledgerRevision={
                      tasksQuery.data
                        ? { watermark: tasksQuery.data.watermark, sourceRevision: tasksQuery.data.sourceRevision }
                        : null
                    }
                    onSelect={openTaskPreview}
                    onDrill={(status) => drillToBoard("__all__", status, "root")}
                    onOpenInbox={() => goto("decisions")}
                    onOpenDecision={navigateToDecision}
                    onNavigateEntity={navigateToEntity}
                    onDecisionPreviewChange={setOverviewDecisionPreviewId}
                    onSetPin={(task, pinned) => {
                      void taskActions.setTaskPin(task, pinned);
                    }}
                  />
                ) : (
                  <WorkspaceSummaryPending error={workspaceSummaryQuery.error} />
                )
              ) : view === "board" ? (
                <BoardView
                  tasks={filteredProjectTasks}
                  allTasks={projectTasks}
                  filters={taskFilters}
                  onFiltersChange={setTaskFilters}
                  onSelect={openTaskPreview}
                  drill={drill}
                  relations={boardRelations}
                  favorites={favorites}
                  onToggleFavorite={toggleFavorite}
                  onStartTask={taskActions.startTask}
                  mutationFeedback={(taskId) => taskActions.feedback.get(taskId)}
                  onSetPin={(task, pinned) => {
                    void taskActions.setTaskPin(task, pinned);
                  }}
                />
              ) : view === "graph" ? (
                <EntityWorkspace
                  entityKinds={entityKinds}
                  governedEntities={governedEntities}
                  focusedEntityRef={focusedEntityRef}
                  tasks={projectTasks}
                  relations={relations}
                  decisions={decisions}
                  facts={facts}
                  coverageRows={coverageRows}
                  factAnchors={factAnchors}
                  agents={runtimePlane.agents}
                  schedules={runtimePlane.schedules}
                  runtimeRelations={runtimePlane.relations}
                  onNavigateEntity={navigateToEntity}
                  onSetTaskPin={(task, pinned) => {
                    void taskActions.setTaskPin(task, pinned);
                  }}
                  onOpenDecisionPool={openDecisionInPool}
                  onFocusEntityChange={focusEntityInWorkspace}
                  recentRefs={recentRefs}
                  entries={paletteEntries}
                  onOpenPalette={() => setPaletteOpen(true)}
                />
              ) : view === "decisionDetail" ? (
                <DecisionDetailView
                  repoId={projectId}
                  decisionId={focusedEntityRef?.startsWith("decision/") ? focusedEntityRef.split("/")[1] : null}
                  decisions={decisions}
                  tasks={projectTasks}
                  relations={relations}
                  loading={triadicQuery.isPending}
                  onBack={back}
                  projectName={project.name}
                  fromViewLabel={navLabel(view)}
                  onNavigateDecision={navigateToDecision}
                  onNavigateTask={navigateToTask}
                  onNavigateEntity={navigateToEntity}
                  onFocusGraph={focusEntityInGraph}
                  onOpenPool={openDecisionInPool}
                />
              ) : view === "factDetail" ? (
                <FactDetailView
                  factRef={focusedEntityRef?.startsWith("fact/") ? focusedEntityRef : null}
                  facts={facts}
                  tasks={tasks}
                  decisions={decisions}
                  relations={relations}
                  factAnchors={factAnchors}
                  coverageRows={coverageRows}
                  loading={triadicQuery.isPending}
                  onNavigateEntity={navigateToEntity}
                  onNavigateDecision={navigateToDecision}
                  onNavigateTask={navigateToTask}
                  onFocusGraph={focusEntityInGraph}
                />
              ) : view === "decisions" ? (
                <DecisionsView
                  decisions={decisions}
                  tasks={tasks}
                  relations={relations}
                  facts={facts}
                  onJudge={decisionActions.judge}
                  mutationFeedback={(decisionId) => decisionActions.feedback.get(decisionId)}
                  onCheckReceipt={(decisionId) => {
                    void decisionActions.checkReceipt(decisionId);
                  }}
                  relationState={triadicQuery.relationState}
                  onNavigateDecision={navigateToDecision}
                  onNavigateTask={navigateToTask}
                  onNavigateEntity={navigateToEntity}
                  onFocusGraph={focusEntityInGraph}
                  coverageRows={coverageRows}
                />
              ) : view === "decisionPool" ? (
                workspaceSummaryQuery.data ? (
                  <DecisionPoolView
                    repoId={projectId}
                    decisions={decisions}
                    summary={workspaceSummaryQuery.data.decisions}
                    facts={facts}
                    relations={relations}
                    coverageRows={coverageRows}
                    relationState={triadicQuery.relationState}
                    onPropose={decisionActions.propose}
                    proposalFeedback={decisionActions.feedback.get("proposal")}
                    onJudge={decisionActions.judge}
                    mutationFeedback={(decisionId) => decisionActions.feedback.get(decisionId)}
                    onCheckReceipt={(key) => {
                      void decisionActions.checkReceipt(key);
                    }}
                    focusedDecisionId={
                      focusedEntityRef?.startsWith("decision/") ? focusedEntityRef.split("/")[1] : null
                    }
                    onFocusGraph={focusEntityInGraph}
                    onNavigateDecision={navigateToDecision}
                  />
                ) : (
                  <WorkspaceSummaryPending error={workspaceSummaryQuery.error} />
                )
              ) : view === "freshness" ? (
                <FreshnessView
                  decisions={decisions}
                  coverageRows={coverageRows}
                  relationState={triadicQuery.relationState}
                  onNavigateEntity={navigateToEntity}
                />
              ) : view === "presets" ? (
                <PresetsView
                  repoId={projectId}
                  // G7:preset/<id> 深链接落目录页内详情(与 task 详情同构,推栈回撤原路返回)。
                  focusedPresetId={
                    focusedEntityRef?.startsWith("preset/") ? focusedEntityRef.slice("preset/".length) : null
                  }
                  onOpenPreset={(presetId) =>
                    navigate({ focusedEntityRef: `preset/${presetId}`, selectedId: null, previewId: null })
                  }
                  onExitDetail={() => updateLocation({ focusedEntityRef: null })}
                  projectName={project.name}
                />
              ) : view === "entities" ? (
                <EntitiesView
                  repoId={projectId}
                  // 实体说明深链接 entitydoc/<kind>:落目录页内详情(与 preset/<id> 同构,
                  // 推栈回撤原路返回)。声明实体的 <kind>/<id> 也落这里(见 entityRoutes)。
                  focusedRef={focusedEntityRef}
                  onOpenEntityDoc={(kind) =>
                    navigate({ focusedEntityRef: `entitydoc/${kind}`, selectedId: null, previewId: null })
                  }
                  onExitDetail={() => updateLocation({ focusedEntityRef: null })}
                  onOpenView={goto}
                  projectName={project.name}
                />
              ) : view === "adapters" ? (
                <AdaptersView repoId={projectId} tasks={projectTasks} />
              ) : view === "sessions" ? (
                <SessionsView
                  repoId={projectId}
                  relations={edgeRelations}
                  focusedEntityRef={focusedEntityRef}
                  onSelectEntity={selectRuntimeEntity}
                  // W5:「编排」段随入口撤销;session → task 的出口改指 Task 详情(派工链所在)。
                  onOpenTask={navigateToTask}
                />
              ) : view === "schedules" ? (
                <SchedulesView
                  repoId={projectId}
                  focusedEntityRef={focusedEntityRef}
                  onSelectEntity={selectRuntimeEntity}
                  onFocusSchedule={(ref) => updateLocation({ focusedEntityRef: ref })}
                  onFocusGraph={focusEntityInGraph}
                />
              ) : view === "artifacts" ? (
                <ArtifactsView repoId={projectId} onNavigateTask={navigateToTask} />
              ) : view === "agentSquad" ? (
                <AgentSquadView
                  repoId={projectId}
                  tasks={projectTasks.map(({ taskId, title, activeExecutionId }) => ({
                    taskId,
                    title,
                    heldLease: activeExecutionId !== undefined,
                  }))}
                  focusedEntityRef={focusedEntityRef}
                  onSelectEntity={selectRuntimeEntity}
                  onFocusGraph={focusEntityInGraph}
                />
              ) : view === "providers" ? (
                <ProvidersView
                  repoId={projectId}
                  focusedEntityRef={focusedEntityRef}
                  onSelectEntity={selectRuntimeEntity}
                />
              ) : view === "terminal" ? (
                <TerminalView
                  repoId={projectId}
                  daemonGeneration={activeRepo?.generation ?? null}
                  tasks={projectTasks.map(({ taskId, title, parentTaskId, coordinationStatus, createdAt }) => ({
                    taskId,
                    title,
                    parentTaskId,
                    status: coordinationStatus,
                    createdAt,
                  }))}
                  launchTask={terminalLaunch}
                  repoRoot={activeRepo?.canonicalRoot ?? null}
                  onNavigateEntity={navigateToEntity}
                  onOpenDocument={openLocalDocument}
                  openUrl={(uri) =>
                    navigate({
                      view: "browser",
                      browserUrl: uri,
                      focusedEntityRef: null,
                      selectedId: null,
                      previewId: null,
                    })
                  }
                />
              ) : view === "browser" ? (
                <BrowserView initialUrl={location.browserUrl} />
              ) : view === "system" ? (
                <SystemView
                  activeRepoId={activeRepoId}
                  onOpenObserve={(repoId) =>
                    navigate({
                      view: "daemonObserve",
                      focusedEntityRef: `daemonRepo/${repoId}`,
                      selectedId: null,
                      previewId: null,
                    })
                  }
                />
              ) : view === "daemonObserve" ? (
                <DaemonObserveView
                  repoId={
                    focusedEntityRef?.startsWith("daemonRepo/")
                      ? focusedEntityRef.slice("daemonRepo/".length)
                      : activeRepoId
                  }
                  repos={systemQuery.data?.repos ?? []}
                  onBack={back}
                  onNavigateEntity={navigateToEntity}
                />
              ) : (
                <SettingsView
                  repoId={activeRepoId}
                  repos={systemQuery.data?.repos ?? []}
                  onOpenProject={(repoId) => {
                    void openProject(repoId);
                  }}
                />
              )}
            </div>
          </div>
        </main>
        <TaskPreviewDrawer
          task={previewTask}
          tasks={projectTasks}
          relations={edgeRelations}
          onClose={() => updateLocation({ previewId: null })}
          onOpenDetail={openTaskDetail}
          onPreviewTask={openTaskPreview}
          onSetPin={(task, pinned) => {
            void taskActions.setTaskPin(task, pinned);
          }}
        />
        <CommandPalette
          open={paletteOpen}
          entries={paletteEntries}
          onSelect={navigateToEntity}
          onClose={() => setPaletteOpen(false)}
        />
        {setupGuide ? (
          <FirstRunGuide
            stage={setupGuide}
            onNext={() => setSetupGuide("agent")}
            onFinish={() => setSetupGuide(null)}
          />
        ) : null}
      </div>
    </LocalDocLayer>
  );
}

export function App() {
  return (
    <ThemeProvider>
      {/* 本机文档浮层(task_89d324b5)挂在 AppShell 内:它需要当前仓的连接模式 ——
          纯展示(remote-proxy)仓本机无文件,项目外本机文件链接禁用并提示
          (PLT-EdgeGUI-W3);其余模式照常读取。 */}
      <AppShell />
    </ThemeProvider>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SnapshotStatus, TaskRow } from "./model/types.ts";
import { ThemeProvider } from "./theme.tsx";
import { HomeView } from "./views/HomeView.tsx";
import { OverviewView } from "./views/OverviewView.tsx";
import { BoardView } from "./views/BoardView.tsx";
import { AttestationPoolView } from "./views/AttestationPoolView.tsx";
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
import { CommandPalette } from "./components/CommandPalette.tsx";
import { useEntityNavigation } from "./navigation/useEntityNavigation.ts";
import { useAppShortcuts } from "./navigation/useAppShortcuts.ts";
import { applyTaskFilters, type TaskFilters } from "./model/taskFilters.ts";
import { adaptProjectionRows } from "./task-adapter.ts";
import { deriveAttestationLanes, type AttestationPoolTabId } from "./model/attestation-pool.ts";
import { invalidateLedgerDependents, useTasksQuery, useTaskWipQuery } from "./task-data.ts";
import { useAgendaQuery } from "./agenda-data.ts";
import {
  useActiveEdgesQuery,
  useDecisionSummaryQuery,
  useRuntimePlaneQuery,
  useTriadicProjectionQuery,
} from "./triadic-data.ts";
import { useSearchIndex } from "./search-index-data.ts";
import { useFavorites } from "./model/favorites.ts";
import { deriveRuntimeHealth } from "./model/runtime-health.ts";
import type { LaneGroupBy } from "./views/SwimlaneBoard.tsx";
import { SessionsView } from "./views/SessionsView.tsx";
import { SchedulesView } from "./views/SchedulesView.tsx";
import { ArtifactsView } from "./views/ArtifactsView.tsx";
import { AgentSquadView } from "./views/AgentSquadView.tsx";
import { ProvidersView } from "./views/ProvidersView.tsx";
import { TokenUsageView } from "./views/TokenUsageView.tsx";
import { useTaskActions } from "./task-actions.ts";
import { useDecisionActions } from "./decision-actions.ts";
import { selectActiveRepoId, useSystemStatusQuery } from "./system-data.ts";
import { useCatalogSnapshot } from "./catalog-data.ts";
import { adaptRepoProject } from "./model/project-adapter.ts";
import { TerminalRoute } from "./views/TerminalRoute.tsx";
import type { TerminalLaunchTask } from "./views/TerminalView.tsx";
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
import { guiTransport } from "./gui-transport.ts";
import { DaemonStartupGate } from "./components/DaemonStartupGate.tsx";

/**
 * 渲染全量决策行的视图。总览只读决策摘要;其他集合内视图同时渲染图 + 决策。
 * 只有这些视图挂载时才读完整投影;
 * 看板/总览之外的普通页(presets/adapters/settings/system/…)与任务看板本身都不在其中。
 */
const FULL_TRIADIC_PROJECTION_VIEWS: ReadonlySet<ViewId> = new Set([
  "graph",
  "decisionPool",
  "decisionDetail",
  "factDetail",
  "freshness",
]);

function AppShell() {
  const desktopOnly = guiTransport().capabilities().terminal?.status === "unavailable";
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
  // 已注册 kind 清单(内核内建 + 本仓 vertical 声明):图筛选、命令面板与实体页同源于此。
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
  const taskWipQuery = useTaskWipQuery(activeRepoId, view === "overview" || view === "board");
  // 总览的「PIN 在做」直接消费 `ha agenda` 同一条 repo.agenda.read 投影。
  // 其他视图不挂载这条读,避免把已删除的独立议程页变成后台读取。
  const agendaQuery = useAgendaQuery(activeRepoId !== null && view === "overview" ? activeRepoId : null);
  const setTaskFilters = useCallback((next: TaskFilters) => updateLocation({ taskFilters: next }), [updateLocation]);
  // 总池 Tab 走 AppLocation(可寻址、刷新不丢),与看板筛选同一「原地改,不推栈」路径。
  const setPoolTab = useCallback((tab: AttestationPoolTabId) => updateLocation({ poolTab: tab }), [updateLocation]);
  // 看板 memo 的比较键里不能有每次渲染都换的函数引用(W9):pin 写通道与
  // mutation feedback 查询在这里收敛为稳定引用,顺着各视图传到每张卡片。
  const handleSetPin = useCallback(
    (task: Pick<TaskRow, "taskId">, pinned: boolean) => {
      void taskActions.setTaskPin(task, pinned);
    },
    [taskActions.setTaskPin],
  );
  const feedbackOf = useCallback((taskId: string) => taskActions.feedback.get(taskId), [taskActions.feedback]);
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
  const tasks = useMemo(() => {
    const roots = new Map(taskWipQuery.data?.roots.map((root) => [root.taskId, root]));
    return adaptProjectionRows(tasksQuery.data?.rows ?? [], projectId, tasksQuery.data?.status).map((task) => {
      const rootAssessment = roots.get(task.taskId);
      return rootAssessment ? { ...task, rootAssessment } : task;
    });
  }, [projectId, taskWipQuery.data, tasksQuery.data]);
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
  // 窄面也按真实消费者挂载:任务详情/⌘K 需要决策标题,其余页面不背景读它们。
  // 事实切面由当前消费者决定启用(⌘K 打开或左栏有搜索输入,见 useSearchIndex);
  // 完整投影同样由挂载的视图决定(裁决 2026-08-29;fact F-9E166C6B:根级全量重取
  // 曾占 GUI 收到字节的 99.13%)。看板徽章不再读任何三元切面:行内
  // placement.spawningDecisionIds 已是同一批 derives 边的结果。
  const fullProjectionMounted = FULL_TRIADIC_PROJECTION_VIEWS.has(view);
  const fullGraphProjectionMounted = fullProjectionMounted;
  // 完整投影视图已经包含 decisions,不再并发读窄面。总览只读它的摘要，抽屉打开
  // 才按 id 读取完整行，不建立第二份全量投影。
  const decisionSummary = useDecisionSummaryQuery(activeRepoId, {
    enabled: !fullProjectionMounted && (view === "overview" || selectedId !== null || paletteOpen),
  });
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

  const decisionReadError = fullProjectionMounted
    ? triadicQuery.decisionError
    : view === "overview"
      ? decisionSummary.error
      : null;
  const decisions = triadicQuery.decisions;
  const facts = triadicQuery.facts;
  const coverageRows = triadicQuery.coverageRows;
  const factAnchors = triadicQuery.factAnchors;
  /** 完整投影视图用的关系集合:只在那些视图挂载时有值。 */
  const relations = triadicQuery.relations;
  /** 边级界面用的关系集合:完整图可用时是全量边,否则是 active 边切面。 */
  const edgeRelations = triadicQuery.graphAvailable ? triadicQuery.relations : activeEdges.relations;
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

  // The badge is the pool's own pending census: the daemon's canonical decision inbox
  // count plus the task-side lanes derived from the same projection rows the pool renders.
  // 决策侧与池内「决策待裁」域计数同读面同判据(workspace summary 的 kernel proposed
  // 判定),角标与域 tab 共享同一 query 缓存,结构性相等。
  const poolBadgeCount = useMemo(() => {
    const lanes = deriveAttestationLanes(projectTasks);
    return (
      (workspaceSummaryQuery.data?.decisions.inboxCount ?? 0) +
      lanes.gates.length +
      lanes.consents.length +
      lanes.breakGlass.length
    );
  }, [projectTasks, workspaceSummaryQuery.data?.decisions.inboxCount]);

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

  // ⌘K 命令面板(REQ-GUI-01)与关系图左栏共用统一实体索引(search-index-data):
  // 事实条目在 ⌘K 打开或左栏有搜索输入时才读,声明实体一并进搜索范围。
  const {
    entries: paletteEntries,
    onSearchActiveChange,
    facts: paletteFacts,
  } = useSearchIndex(activeRepoId, paletteOpen, projectTasks, chromeDecisions, governedEntities);
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
          poolBadgeCount={poolBadgeCount}
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
          {desktopOnly ? (
            <div
              data-testid="browser-capability-notice"
              className="border-b border-border px-3 py-1 ui-meta text-text-muted"
            >
              实时流、终端和本机文件仅桌面版可用。
            </div>
          ) : null}
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
                  onSubmit={() => taskActions.submitTask(selected)}
                  onComplete={(consent) => taskActions.completeTask(selected, consent)}
                  onAttest={taskActions.attestGate}
                  onSetPin={handleSetPin}
                  onOpenTerminal={(task) => {
                    setTerminalLaunch({ requestId: crypto.randomUUID(), taskId: task.taskId, title: task.title });
                    updateLocation({ selectedId: null });
                    goto("terminal");
                  }}
                  onFocusGraph={focusEntityInGraph}
                />
              ) : decisionReadError ? (
                <WorkspaceSummaryPending error={decisionReadError} />
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
                    repoId={projectId}
                    project={project}
                    tasks={projectTasks}
                    wipSnapshot={taskWipQuery.data}
                    agenda={agendaQuery.data}
                    decisions={decisionSummary.decisions}
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
                    onOpenInbox={() =>
                      // 决策收件箱 = 总池的决策待裁域(专注裁决从域内进入)。
                      navigate({
                        view: "decisionPool",
                        poolTab: "decisions",
                        focusedEntityRef: null,
                        selectedId: null,
                        previewId: null,
                        drill: null,
                      })
                    }
                    onOpenDecision={navigateToDecision}
                    onNavigateEntity={navigateToEntity}
                    onDecisionPreviewChange={setOverviewDecisionPreviewId}
                    onSetPin={handleSetPin}
                  />
                ) : (
                  <WorkspaceSummaryPending error={workspaceSummaryQuery.error} />
                )
              ) : view === "board" ? (
                <BoardView
                  tasks={filteredProjectTasks}
                  allTasks={projectTasks}
                  wipSnapshot={taskWipQuery.data}
                  filters={taskFilters}
                  onFiltersChange={setTaskFilters}
                  onSelect={openTaskPreview}
                  drill={drill}
                  favorites={favorites}
                  onToggleFavorite={toggleFavorite}
                  onStartTask={taskActions.startTask}
                  mutationFeedback={feedbackOf}
                  onSetPin={handleSetPin}
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
                  relationState={triadicQuery.relationState}
                  onOpenPalette={() => setPaletteOpen(true)}
                  onSearchActiveChange={onSearchActiveChange}
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
              ) : view === "decisionPool" ? (
                workspaceSummaryQuery.data ? (
                  <AttestationPoolView
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
                    tasks={projectTasks}
                    onAttest={taskActions.attestGate}
                    taskFeedback={feedbackOf}
                    onCompleteTask={(task, consent) => taskActions.completeTask(task, consent)}
                    onNavigateTask={navigateToTask}
                    poolTab={location.poolTab ?? "decisions"}
                    onPoolTabChange={setPoolTab}
                    focusedDecisionId={
                      focusedEntityRef?.startsWith("decision/") ? focusedEntityRef.split("/")[1] : null
                    }
                    onFocusGraph={focusEntityInGraph}
                    onNavigateDecision={navigateToDecision}
                    onNavigateEntity={navigateToEntity}
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
                  // 实体页深链接 entitydoc/<kind>:落目录页内详情(与 preset/<id> 同构,
                  // 推栈回撤原路返回)。声明实体的 <kind>/<id> 也落这里(见 entityRoutes)。
                  focusedRef={focusedEntityRef}
                  onOpenEntityDoc={(kind) =>
                    navigate({ focusedEntityRef: `entitydoc/${kind}`, selectedId: null, previewId: null })
                  }
                  onOpenEntityRef={(ref) => navigateToEntity(ref)}
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
              ) : view === "tokenUsage" ? (
                <TokenUsageView
                  repoId={projectId}
                  // tokenAgent/<id> · tokenSquad/<id>:详情推栈,前进后退原路返回(与 schedule 同构)。
                  focusedEntityRef={focusedEntityRef}
                  onFocusMember={(ref) => navigate({ focusedEntityRef: ref })}
                  onSelectEntity={selectRuntimeEntity}
                  onOpenTask={navigateToTask}
                />
              ) : view === "terminal" ? (
                <TerminalRoute
                  repoId={projectId}
                  daemonGeneration={activeRepo?.generation ?? null}
                  tasks={projectTasks}
                  launchTask={terminalLaunch}
                  repoRoot={activeRepo?.canonicalRoot ?? null}
                  navigate={navigate}
                  onNavigateEntity={navigateToEntity}
                  onOpenDocument={openLocalDocument}
                />
              ) : view === "browser" ? (
                <BrowserView initialUrl={location.browserUrl} />
              ) : view === "system" ? (
                <SystemView
                  activeRepoId={activeRepoId}
                  onNavigateEntity={navigateToEntity}
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
        {edgeSurfaceMounted &&
        !triadicQuery.graphAvailable &&
        (activeEdges.hasNextPage || activeEdges.relationState === "error") ? (
          <aside className="fixed bottom-4 left-4 z-50 rounded border border-border bg-bg p-3" role="status">
            <span>{activeEdges.relationState === "error" ? "关系读取失败。" : "当前关系尚未全部加载。"}</span>
            {activeEdges.hasNextPage ? (
              <button disabled={activeEdges.isFetching} onClick={() => void activeEdges.fetchNextPage()}>
                加载更多关系
              </button>
            ) : null}
          </aside>
        ) : null}
        <TaskPreviewDrawer
          task={previewTask}
          tasks={projectTasks}
          relations={edgeRelations}
          onClose={() => updateLocation({ previewId: null })}
          onOpenDetail={openTaskDetail}
          onPreviewTask={openTaskPreview}
          onSetPin={handleSetPin}
        />
        <CommandPalette
          open={paletteOpen}
          entries={paletteEntries}
          factsIncomplete={paletteFacts.hasNextPage}
          factsLoading={paletteFacts.isFetching}
          factsError={paletteFacts.isError}
          onLoadFacts={() => void paletteFacts.fetchNextPage()}
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
      <DaemonStartupGate>
        <AppShell />
      </DaemonStartupGate>
    </ThemeProvider>
  );
}

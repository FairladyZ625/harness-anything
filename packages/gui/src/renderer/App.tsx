import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FolderSimple, CaretUpDown, CloudSlash, WarningCircle } from "@phosphor-icons/react";
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
import { AdaptersView } from "./views/AdaptersView.tsx";
import { SettingsView } from "./views/SettingsView.tsx";
import { SystemView } from "./views/SystemView.tsx";
import { DaemonObserveView } from "./views/DaemonObserveView.tsx";
import { TaskDetailView } from "./views/TaskDetailView.tsx";
import { TaskPreviewDrawer } from "./components/TaskPreviewDrawer.tsx";
import { ThemeToggle, NavButton, ProjectSummary, TaskCensusSummary } from "./components/shell-chrome.tsx";
import { CommandPalette, buildPaletteIndex } from "./components/CommandPalette.tsx";
import { useEntityNavigation } from "./navigation/useEntityNavigation.ts";
import { useAppShortcuts } from "./navigation/useAppShortcuts.ts";
import { applyTaskFilters, type TaskFilters } from "./model/taskFilters.ts";
import { adaptProjectionRows } from "./task-adapter.ts";
import { invalidateLedgerDependents, LEDGER_REFRESH_INTERVAL_MS, useTasksQuery } from "./task-data.ts";
import { useTriadicProjectionQuery } from "./triadic-data.ts";
import { useFavorites } from "./model/favorites.ts";
import type { LaneGroupBy } from "./views/SwimlaneBoard.tsx";
import { SessionsView } from "./views/SessionsView.tsx";
import { AgentSquadView } from "./views/AgentSquadView.tsx";
import { ProvidersView } from "./views/ProvidersView.tsx";
import { useTaskActions } from "./task-actions.ts";
import { useDecisionActions } from "./decision-actions.ts";
import { selectActiveRepoId, useSystemStatusQuery } from "./system-data.ts";
import { useCatalogSnapshot } from "./catalog-data.ts";
import { adaptRepoProject } from "./model/project-adapter.ts";
import { TerminalDock, type TerminalDockHandle } from "./components/TerminalDock.tsx";
import { NavigationHistoryBar } from "./components/NavigationHistoryBar.tsx";
import { t } from "./i18n/index.tsx";
import { useViewHistory } from "./navigation/useViewHistory.ts";
import { useLocationRestore } from "./navigation/useLocationRestore.ts";
import { initialLocation, resetViewHistory } from "./navigation/viewHistoryStorage.ts";
import type { ViewId } from "./navigation/viewHistory.ts";
import { navLabel, NAV_GROUPS } from "./navigation/navConfig.tsx";
import { useWorkspaceSummaryQuery } from "./workspace-summary-data.ts";
import { WorkspaceSummaryPending } from "./components/WorkspaceSummaryPending.tsx";
import { prewarmRuntimeInstanceCatalog } from "./runtime-instance-data.ts";

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
  const tasksQuery = useTasksQuery(activeRepoId);
  const workspaceSummaryQuery = useWorkspaceSummaryQuery(activeRepoId);
  const lastLedgerCut = useRef<string | null>(null);
  const triadicQuery = useTriadicProjectionQuery(activeRepoId);
  const catalogQuery = useCatalogSnapshot(activeRepoId);
  const taskActions = useTaskActions(projectId);
  const decisionActions = useDecisionActions(projectId);
  const tasks = useMemo(
    () =>
      adaptProjectionRows(tasksQuery.data?.rows ?? [], projectId, tasksQuery.data?.status, {
        relationState: triadicQuery.relationState,
        relations: triadicQuery.relations,
        decisions: triadicQuery.decisions,
        relationWarnings: triadicQuery.relationWarnings,
      }),
    [
      projectId,
      tasksQuery.data,
      triadicQuery.relationState,
      triadicQuery.relations,
      triadicQuery.decisions,
      triadicQuery.relationWarnings,
    ],
  );
  const activeRepo = systemQuery.data?.repos.find((repo) => repo.repoId === activeRepoId);
  const project = adaptRepoProject(
    projectId,
    activeRepo,
    catalogQuery.data?.defaults.presetId,
    tasks[0]?.lastKnownAt ?? systemQuery.data?.observedAt ?? new Date(0).toISOString(),
    triadicQuery.decisions.length,
    triadicQuery.facts.length,
  );
  const { favorites, toggleFavorite } = useFavorites(projectId);

  useEffect(() => {
    if (!activeRepoId || !tasksQuery.data) return;
    const cut = `${activeRepoId}:${tasksQuery.data.watermark}:${tasksQuery.data.sourceRevision}`;
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

  const decisions = triadicQuery.decisions;
  const facts = triadicQuery.facts;
  const relations = triadicQuery.relations;
  const coverageRows = triadicQuery.coverageRows;
  const factAnchors = triadicQuery.factAnchors;
  // 应用位置由视图导航历史栈持有(REQ-GUI-01):view/selectedId/previewId/
  // focusedEntityRef/taskFilters/drill 全部从 location 派生,变更走 navigate()
  // (推栈)或 updateLocation()(原地改)。与图内 FocusHistoryBar 并存:那是
  // 聚光灯的实体焦点微历史,这是跨视图的应用位置历史。
  const { location, navigate, updateLocation, back, forward, canBack, canForward } = useViewHistory(
    projectId,
    initialLocation(),
  );
  // 回退保真(G10):导航栈恢复应用位置;这里在它旁边恢复 DOM 层的滚动与焦点。
  useLocationRestore(location, document.body);
  const { view, selectedId, previewId, focusedEntityRef, taskFilters, drill } = location;
  const setTaskFilters = (next: TaskFilters) => updateLocation({ taskFilters: next });
  const [projectSwitcherOpen, setProjectSwitcherOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const terminalDock = useRef<TerminalDockHandle>(null);

  const projectTasks = useMemo(() => tasks.filter((t) => t.projectId === projectId), [tasks, projectId]);
  const selected = useMemo(() => tasks.find((t) => t.taskId === selectedId) ?? null, [tasks, selectedId]);
  const previewTask = useMemo(() => tasks.find((t) => t.taskId === previewId) ?? null, [previewId, tasks]);
  const filteredProjectTasks = useMemo(
    () => applyTaskFilters(projectTasks, taskFilters, favorites),
    [projectTasks, taskFilters, favorites],
  );

  // The badge is the daemon's canonical inbox count; renderer rows are not a second census.
  const inboxCount = workspaceSummaryQuery.data?.decisions.inboxCount;

  // 总览第四格输入(口径见 model/runtime-health.ts):daemon 响应折算自
  // systemQuery 成败 + observedAt 年龄;投影落后取 tasksQuery 的同一对数字。
  const overviewSystemHealth = useMemo(
    () => ({
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
    }),
    [activeRepo, systemQuery.data, systemQuery.isError, tasksQuery.data],
  );

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
      await terminalDock.current?.detachAll();
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
  });

  // ⌘K 命令面板(REQ-GUI-01):跨实体搜索 + 快速跳转。纯前端派生,不消费写 IPC。
  const paletteEntries = useMemo(
    () => buildPaletteIndex(projectTasks, decisions, facts),
    [projectTasks, decisions, facts],
  );

  useAppShortcuts({
    onTogglePalette: () => setPaletteOpen((open) => !open),
    onToggleTerminal: () => setTerminalOpen((open) => !open),
    onBack: back,
    onForward: forward,
  });

  return (
    <div className="flex h-dvh flex-col overflow-hidden md:flex-row">
      <aside className="flex max-h-[42dvh] w-full shrink-0 flex-col overflow-y-auto border-b border-border bg-surface md:max-h-none md:w-56 md:overflow-visible md:border-r md:border-b-0">
        <div className="flex items-center gap-2 px-3 pt-3 pb-1">
          <span className="font-mono text-[11px] font-semibold tracking-wide text-text-muted">HARNESS</span>
          <span
            title={t("components.appSidebar.localModeNotSynchronizedV2MultiTerminal")}
            className="inline-flex items-center gap-1 rounded border border-border px-1 py-px font-mono text-[10px] text-text-faint"
          >
            <CloudSlash weight="bold" />
            {t("components.appSidebar.local")}
          </span>
          <div className="ml-auto">
            <ThemeToggle />
          </div>
        </div>

        <div className="px-3 pb-1">
          {workspaceSummaryQuery.isSuccess ? (
            workspaceSummaryQuery.data.tasks.total > 0 ? (
              <TaskCensusSummary summary={workspaceSummaryQuery.data.tasks} />
            ) : (
              <span data-testid="task-empty-state" className="block font-mono text-[11px] text-text-faint">
                {t("components.appSidebar.noTaskRowsFromLocalBridge")}
              </span>
            )
          ) : workspaceSummaryQuery.isError ? (
            <span data-testid="task-error-state" className="block font-mono text-[11px] text-status-blocked">
              {t("components.appSidebar.failedReadLedgerBridge")}:{" "}
              {workspaceSummaryQuery.error instanceof Error
                ? workspaceSummaryQuery.error.message
                : String(workspaceSummaryQuery.error)}
            </span>
          ) : (
            <span className="block font-mono text-[11px] text-text-faint">
              {t("components.appSidebar.readLocalLedger")}
            </span>
          )}
          {tasksQuery.data && (
            <span data-testid="ledger-refresh-status" className="mt-0.5 block font-mono text-[10px] text-text-faint">
              {tasksQuery.isRefetchError
                ? t("components.appSidebar.ledgerRefreshFailed", { watermark: String(tasksQuery.data.watermark) })
                : tasksQuery.data.status === "pending"
                  ? t("components.appSidebar.ledgerCatchingUp", {
                      watermark: String(tasksQuery.data.watermark),
                      sourceRevision: String(tasksQuery.data.sourceRevision),
                    })
                  : tasksQuery.isFetching
                    ? t("components.appSidebar.ledgerChecking", { watermark: String(tasksQuery.data.watermark) })
                    : t("components.appSidebar.ledgerRevision", {
                        watermark: String(tasksQuery.data.watermark),
                        seconds: String(LEDGER_REFRESH_INTERVAL_MS / 1_000),
                      })}
            </span>
          )}
        </div>

        <div className="px-3 pt-2 pb-2">
          <div className="relative">
            <button
              onClick={() => setProjectSwitcherOpen((open) => !open)}
              title={t("components.appSidebar.quicklySwitchProjects")}
              className={`flex w-full items-center gap-2 rounded-md border px-2 py-2 text-left text-sm font-medium hover:border-border-strong ${
                projectSwitcherOpen || view === "home"
                  ? "border-border-strong bg-surface-raised"
                  : "border-border bg-surface-raised"
              }`}
            >
              <FolderSimple weight="duotone" className="shrink-0 text-text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{project.name}</span>
                <span className="block truncate font-mono text-[11px] text-text-faint">{project.preset}</span>
              </span>
              <CaretUpDown weight="bold" className="shrink-0 text-text-faint" />
            </button>

            {projectSwitcherOpen && (
              <div className="absolute left-0 right-0 z-30 mt-2 rounded-lg border border-border-strong bg-surface-raised p-2 shadow-2xl shadow-black/35 md:right-auto md:w-[320px]">
                <div className="flex items-center justify-between px-1 pb-2">
                  <span className="font-mono text-[11px] uppercase tracking-wide text-text-faint">
                    {t("components.appSidebar.quickSwitch")}
                  </span>
                  <span className="font-mono text-[11px] text-text-faint">
                    {t("components.appSidebar.projectCount", { count: systemQuery.data?.repos.length ?? 0 })}
                  </span>
                </div>
                <div className="flex max-h-[330px] flex-col gap-1.5 overflow-y-auto">
                  {(systemQuery.data?.repos ?? []).map((repo) => (
                    <ProjectSummary
                      key={repo.repoId}
                      repo={repo}
                      active={repo.repoId === activeRepoId}
                      onOpen={() => {
                        void openProject(repo.repoId);
                      }}
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
                    {t("components.appSidebar.manageAll")}
                  </button>
                  <button
                    disabled
                    className="inline-flex items-center justify-center gap-1 rounded-md border border-border px-2 py-1.5 text-[12px] text-text-faint opacity-70"
                  >
                    <WarningCircle weight="bold" />
                    {t("components.appSidebar.localMode")}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {NAV_GROUPS.map((group, groupIndex) => (
          <div key={group.id}>
            <div
              className={`px-3 font-mono text-[12px] uppercase tracking-wide text-text-faint ${groupIndex === 0 ? "pt-1 pb-1" : "pt-3 pb-1"}`}
            >
              {t(group.labelKey)}
            </div>
            <nav className="flex gap-1 overflow-x-auto px-2 pb-1 md:flex-col md:gap-0.5 md:overflow-visible md:pb-0">
              {group.items.map((item) => (
                <NavButton
                  key={item.id}
                  active={view === item.id && !selected}
                  onClick={() => goto(item.id)}
                  icon={item.icon}
                  label={navLabel(item.id)}
                  badge={item.id === "decisions" ? inboxCount : undefined}
                />
              ))}
            </nav>
          </div>
        ))}

        <div className="mt-auto hidden border-t border-border px-3 py-2.5 md:block">
          <button
            disabled
            title={t("components.appSidebar.v2PreviewAfterLoggingYourAccountYou")}
            className="flex w-full cursor-not-allowed items-center gap-2 text-left opacity-70"
          >
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-raised font-mono text-[11px] font-semibold text-text-muted">
              Z
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs text-text">{t("components.appSidebar.localMode2")}</span>
              <span className="block truncate text-[10px] text-text-faint">
                {t("components.appSidebar.accountSynchronizationV2")}
              </span>
            </span>
          </button>
        </div>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <NavigationHistoryBar canBack={canBack} canForward={canForward} onBack={back} onForward={forward} />
        <div key={projectId} className="flex min-h-0 min-w-0 flex-1 flex-row overflow-hidden">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {selected ? (
              <TaskDetailView
                task={selected}
                tasks={tasks}
                relations={relations}
                decisions={decisions}
                onBack={() => updateLocation({ selectedId: null })}
                onSelect={(id) => updateLocation({ selectedId: id })}
                projectName={project.name}
                fromViewLabel={navLabel(view)}
                onNavigateDecision={navigateToDecision}
                onNavigateEntity={navigateToEntity}
                mutationFeedback={taskActions.feedback.get(selected.taskId)}
                onProgress={(input) => taskActions.appendProgress(selected, input)}
                onSubmit={(submission) => taskActions.submitTask(selected, submission)}
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
                  decisions={decisions}
                  workspaceSummary={workspaceSummaryQuery.data}
                  relations={relations}
                  systemHealth={overviewSystemHealth}
                  onSelect={openTaskPreview}
                  onDrill={(status) => drillToBoard("__all__", status, "root")}
                  onOpenInbox={() => goto("decisions")}
                  onOpenDecision={navigateToDecision}
                  onOpenSystem={() => goto("system")}
                  onNavigateEntity={navigateToEntity}
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
                relations={relations}
                favorites={favorites}
                onToggleFavorite={toggleFavorite}
                onStartTask={taskActions.startTask}
                mutationFeedback={(taskId) => taskActions.feedback.get(taskId)}
              />
            ) : view === "graph" ? (
              <EntityWorkspace
                focusedEntityRef={focusedEntityRef}
                tasks={projectTasks}
                relations={relations}
                decisions={decisions}
                facts={facts}
                coverageRows={coverageRows}
                factAnchors={factAnchors}
                onNavigateEntity={navigateToEntity}
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
                loading={triadicQuery.isLoading}
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
                loading={triadicQuery.isLoading}
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
                  focusedDecisionId={focusedEntityRef?.startsWith("decision/") ? focusedEntityRef.split("/")[1] : null}
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
            ) : view === "adapters" ? (
              <AdaptersView repoId={projectId} tasks={projectTasks} />
            ) : view === "sessions" ? (
              <SessionsView
                repoId={projectId}
                relations={relations}
                focusedEntityRef={focusedEntityRef}
                onSelectEntity={selectRuntimeEntity}
                // W5:「编排」段随入口撤销;session → task 的出口改指 Task 详情(派工链所在)。
                onOpenTask={navigateToTask}
              />
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
              />
            ) : view === "providers" ? (
              <ProvidersView
                repoId={projectId}
                focusedEntityRef={focusedEntityRef}
                onSelectEntity={selectRuntimeEntity}
              />
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
              <SettingsView />
            )}
          </div>
        </div>
      </main>
      <TaskPreviewDrawer
        task={previewTask}
        tasks={projectTasks}
        relations={relations}
        onClose={() => updateLocation({ previewId: null })}
        onOpenDetail={openTaskDetail}
        onPreviewTask={openTaskPreview}
      />
      <CommandPalette
        open={paletteOpen}
        entries={paletteEntries}
        onSelect={navigateToEntity}
        onClose={() => setPaletteOpen(false)}
      />
      <TerminalDock
        ref={terminalDock}
        repoId={projectId}
        daemonGeneration={activeRepo?.generation ?? null}
        tasks={projectTasks.map(({ taskId, title }) => ({ taskId, title }))}
        open={terminalOpen}
        onToggle={() => setTerminalOpen((open) => !open)}
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

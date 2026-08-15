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
import { FactTriageView } from "./views/FactTriageView.tsx";
import { ExecutionEvidenceView } from "./views/ExecutionEvidenceView.tsx";
import { EntityWorkspace } from "./components/EntityWorkspace.tsx";
import { PresetsView } from "./views/PresetsView.tsx";
import { AdaptersView } from "./views/AdaptersView.tsx";
import { SettingsView } from "./views/SettingsView.tsx";
import { SystemView } from "./views/SystemView.tsx";
import { TaskDetailView } from "./views/TaskDetailView.tsx";
import { TaskPreviewDrawer } from "./components/TaskPreviewDrawer.tsx";
import { ThemeToggle, NavButton, ProjectSummary } from "./components/shell-chrome.tsx";
import { CommandPalette, buildPaletteIndex } from "./components/CommandPalette.tsx";
import { pushRecentRef } from "./navigation/recentRefs.ts";
import { applyTaskFilters, type TaskFilters } from "./model/taskFilters.ts";
import { adaptProjectionRows } from "./task-adapter.ts";
import { taskQueryKeys, useTasksQuery } from "./task-data.ts";
import { useTriadicProjectionQuery } from "./triadic-data.ts";
import { useFavorites } from "./model/favorites.ts";
import type { LaneGroupBy } from "./views/SwimlaneBoard.tsx";
import { RuntimeWorkspace } from "./views/RuntimeWorkspace.tsx";
import { useTaskActions } from "./task-actions.ts";
import { useDecisionActions } from "./decision-actions.ts";
import { selectActiveRepoId, useSystemStatusQuery } from "./system-data.ts";
import { useCatalogSnapshot } from "./catalog-data.ts";
import { adaptRepoProject } from "./model/project-adapter.ts";
import { TerminalDock, type TerminalDockHandle } from "./components/TerminalDock.tsx";
import { NavigationHistoryBar } from "./components/NavigationHistoryBar.tsx";
import { t } from "./i18n/index.tsx";
import { useViewHistory } from "./navigation/useViewHistory.ts";
import { initialLocation, resetViewHistory } from "./navigation/viewHistoryStorage.ts";
import type { ViewId } from "./navigation/viewHistory.ts";
import { navLabel, WORKSPACE_NAV, MANAGE_NAV } from "./navigation/navConfig.tsx";


function AppShell() {
  const [activeRepoId, setActiveRepoId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const systemQuery = useSystemStatusQuery();
  const enabledRepos = useMemo(() => systemQuery.data?.repos.filter((repo) => repo.registrationState === "enabled") ?? [], [systemQuery.data?.repos]);
  useEffect(() => {
    const next = selectActiveRepoId(systemQuery.data?.repos ?? [], activeRepoId); if (next !== activeRepoId) setActiveRepoId(next);
  }, [activeRepoId, systemQuery.data?.repos]);
  const projectId = activeRepoId ?? "unselected";
  const tasksQuery = useTasksQuery(activeRepoId);
  const triadicQuery = useTriadicProjectionQuery(activeRepoId);
  const catalogQuery = useCatalogSnapshot(activeRepoId);
  const taskActions = useTaskActions(projectId);
  const decisionActions = useDecisionActions(projectId);
  const tasks = useMemo(
    () => adaptProjectionRows(tasksQuery.data?.rows ?? [], projectId, tasksQuery.data?.status, {
      relationState: triadicQuery.relationState,
      relations: triadicQuery.relations,
      decisions: triadicQuery.decisions,
      relationWarnings: triadicQuery.relationWarnings
    }),
    [projectId, tasksQuery.data, triadicQuery.relationState, triadicQuery.relations, triadicQuery.decisions, triadicQuery.relationWarnings],
  );
  const activeRepo = systemQuery.data?.repos.find((repo) => repo.repoId === activeRepoId);
  const project = adaptRepoProject(projectId, activeRepo, catalogQuery.data?.defaults.presetId,
    tasks[0]?.lastKnownAt ?? systemQuery.data?.observedAt ?? new Date(0).toISOString(),
    triadicQuery.decisions.length, triadicQuery.facts.length);
  const { favorites, toggleFavorite } = useFavorites(projectId);

  const decisions = triadicQuery.decisions;
  const facts = triadicQuery.facts;
  const relations = triadicQuery.relations;
  const coverageRows = triadicQuery.coverageRows;
  const factAnchors = triadicQuery.factAnchors;
  // 应用位置由视图导航历史栈持有(REQ-GUI-01):view/selectedId/previewId/
  // focusedEntityRef/taskFilters/drill 全部从 location 派生,变更走 navigate()
  // (推栈)或 updateLocation()(原地改)。与图内 FocusHistoryBar 并存:那是
  // 聚光灯的实体焦点微历史,这是跨视图的应用位置历史。
  const { location, navigate, updateLocation, back, forward, canBack, canForward } =
    useViewHistory(projectId, initialLocation());
  const { view, selectedId, previewId, focusedEntityRef, taskFilters, drill } = location;
  const setTaskFilters = (next: TaskFilters) => updateLocation({ taskFilters: next });
  const [projectSwitcherOpen, setProjectSwitcherOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // 最近访问(关系图左栏数据源):点过的 task/decision/fact 推到头部,去重 + 截断。
  const [recentRefs, setRecentRefs] = useState<string[]>([]);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const terminalDock = useRef<TerminalDockHandle>(null);

  const projectTasks = useMemo(
    () => tasks.filter((t) => t.projectId === projectId),
    [tasks, projectId],
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
      setRecentRefs([]);
      setActiveRepoId(repoId);
    }
    setProjectSwitcherOpen(false);
    goto("overview");
  };

  const drillToBoard = (
    lane: string,
    status: SnapshotStatus,
    dimension: "root" | "module" | "plt",
  ) => {
    // 特殊占位 __all__ 表示不锁定 lane(只 drill 到状态维度)
    const groupBy: LaneGroupBy =
      dimension === "root" ? "root" : dimension === "module" ? "module" : "productLine";
    navigate({ drill: { lane, status, groupBy }, view: "board", selectedId: null, previewId: null });
  };

  const openTaskPreview = (id: string) => {
    updateLocation({ selectedId: null, previewId: id });
  };

  const openTaskDetail = (id: string) => {
    navigate({ focusedEntityRef: `task/${id}`, previewId: null, selectedId: id });
  };

  // 带 repo/<repoId>/ 前缀的实体引用先显式切仓，再在该仓导航。
  const navigateLocalEntity = (ref: string) => {
    setRecentRefs((prev) => pushRecentRef(prev, ref));
    if (ref.startsWith("task/")) {
      const id = ref.slice(5).split("/")[0];
      openTaskDetail(id);
    } else if (ref.startsWith("decision/")) {
      const decisionId = ref.split("/")[1];
      navigate({ focusedEntityRef: `decision/${decisionId}`, view: "decisionPool", selectedId: null, previewId: null });
    } else if (ref.startsWith("fact/")) {
      navigate({ focusedEntityRef: ref, view: "factTriage", selectedId: null, previewId: null });
    }
  };
  const navigateToEntity = (rawRef: string) => {
    const scoped = /^repo\/([^/]+)\/(.+)$/u.exec(rawRef), targetRepoId = scoped?.[1] ?? activeRepoId, ref = scoped?.[2] ?? rawRef;
    if (targetRepoId && targetRepoId !== activeRepoId) {
      if (!enabledRepos.some((repo) => repo.repoId === targetRepoId)) { navigate({ view: "home" }); setProjectSwitcherOpen(true); return; }
      void openProject(targetRepoId).then(() => navigateLocalEntity(ref)); return;
    }
    navigateLocalEntity(ref);
  };
  const navigateToDecision = (decisionId: string) =>
    navigateToEntity(`decision/${decisionId}`);
  const navigateToTask = (taskId: string) => openTaskDetail(taskId);
  const focusEntityInGraph = (ref: string) => {
    setRecentRefs((prev) => pushRecentRef(prev, ref));
    navigate({ focusedEntityRef: ref, view: "graph", selectedId: null, previewId: null });
  };

  // ⌘K 命令面板(REQ-GUI-01):跨实体搜索 + 快速跳转。纯前端派生,不消费写 IPC。
  const paletteEntries = useMemo(
    () => buildPaletteIndex(projectTasks, decisions, facts),
    [projectTasks, decisions, facts],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        setTerminalOpen((open) => !open);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "[") {
        e.preventDefault();
        back();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "]") {
        e.preventDefault();
        forward();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back, forward]);

  // 鼠标侧键:button 3 = 后退,button 4 = 前进(浏览器/Electron 惯例)。
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 3) back();
      else if (e.button === 4) forward();
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [back, forward]);

  const handlePaletteSelect = (ref: string) => {
    navigateToEntity(ref);
  };

  return (
    <div className="flex h-dvh flex-col overflow-hidden md:flex-row">
      <aside className="flex max-h-[42dvh] w-full shrink-0 flex-col overflow-y-auto border-b border-border bg-surface md:max-h-none md:w-56 md:overflow-visible md:border-r md:border-b-0">
        <div className="flex items-center gap-2 px-3 pt-3 pb-1">
          <span className="font-mono text-[11px] font-semibold tracking-wide text-text-muted">
            HARNESS
          </span>
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
          {tasksQuery.isSuccess ? (
            projectTasks.length > 0 ? (
              <span
                data-testid="real-task-summary"
                className="block font-mono text-[11px] text-text-faint"
              >
                {t("components.appSidebar.activeWorkSummary", { activeCount, totalCount: projectTasks.length })}
              </span>
            ) : (
              <span
                data-testid="task-empty-state"
                className="block font-mono text-[11px] text-text-faint"
              >
                {t("components.appSidebar.noTaskRowsFromLocalBridge")}
              </span>
            )
          ) : tasksQuery.isError ? (
            <span data-testid="task-error-state" className="block font-mono text-[11px] text-status-blocked">
              {t("components.appSidebar.failedReadLedgerBridge")}: {tasksQuery.error instanceof Error ? tasksQuery.error.message : String(tasksQuery.error)}
            </span>
          ) : (
            <span className="block font-mono text-[11px] text-text-faint">
              {t("components.appSidebar.readLocalLedger")}
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
                      onOpen={() => { void openProject(repo.repoId); }}
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

        <div className="px-3 pt-1 pb-1 font-mono text-[12px] uppercase tracking-wide text-text-faint">
          {t("shell.nav.workspace")}
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-1 md:flex-col md:gap-0.5 md:overflow-visible md:pb-0">
          {WORKSPACE_NAV.map((item) => (
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

        <div className="px-3 pt-3 pb-1 font-mono text-[12px] uppercase tracking-wide text-text-faint">
          {t("shell.nav.manage")}
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:gap-0.5 md:overflow-visible md:pb-0">
          {MANAGE_NAV.map((item) => (
            <NavButton
              key={item.id}
              active={view === item.id && !selected}
              onClick={() => goto(item.id)}
              icon={item.icon}
              label={navLabel(item.id)}
            />
          ))}
        </nav>

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
        <NavigationHistoryBar
          canBack={canBack}
          canForward={canForward}
          onBack={back}
          onForward={forward}
        />
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
                onOpenProject={(repoId) => { void openProject(repoId); }}
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
                onFocusEntityChange={(ref) =>
                  ref === null ? updateLocation({ focusedEntityRef: null }) : navigate({ focusedEntityRef: ref })
                }
                recentRefs={recentRefs}
                entries={paletteEntries}
                onOpenPalette={() => setPaletteOpen(true)}
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
            ) : view === "executionEvidence" ? (
              <ExecutionEvidenceView
                rows={tasksQuery.data?.rows ?? []}
                queryStatus={tasksQuery.isError ? "error" : tasksQuery.isLoading ? "loading" : "ready"}
                projectionStatus={tasksQuery.data?.status}
                isFetching={tasksQuery.isFetching}
                error={tasksQuery.error}
                onReload={() => { void tasksQuery.refetch(); }}
                onReloadFromFirst={() => { void queryClient.invalidateQueries({ queryKey: taskQueryKeys.list(projectId) }); }}
              />
            ) : view === "decisions" ? (
              <DecisionsView
                decisions={decisions}
                tasks={tasks}
                relations={relations}
                facts={facts}
                onJudge={decisionActions.judge}
                mutationFeedback={(decisionId) => decisionActions.feedback.get(decisionId)}
                onCheckReceipt={(decisionId) => { void decisionActions.checkReceipt(decisionId); }}
                relationState={triadicQuery.relationState}
                onNavigateDecision={navigateToDecision}
                onNavigateTask={navigateToTask}
                onFocusGraph={focusEntityInGraph}
                coverageRows={coverageRows}
              />
            ) : view === "decisionPool" ? (
              <DecisionPoolView
                repoId={projectId}
                decisions={decisions}
                facts={facts}
                relations={relations}
                coverageRows={coverageRows}
                relationState={triadicQuery.relationState}
                onPropose={decisionActions.propose}
                proposalFeedback={decisionActions.feedback.get("proposal")}
                onJudge={decisionActions.judge}
                mutationFeedback={(decisionId) => decisionActions.feedback.get(decisionId)}
                onCheckReceipt={(key) => { void decisionActions.checkReceipt(key); }}
                focusedDecisionId={
                  focusedEntityRef?.startsWith("decision/")
                    ? focusedEntityRef.split("/")[1]
                    : null
                }
                onFocusGraph={focusEntityInGraph}
              />
            ) : view === "presets" ? (
              <PresetsView repoId={projectId} />
            ) : view === "adapters" ? (
              <AdaptersView repoId={projectId} tasks={projectTasks} />
            ) : view === "agents" ? (
              <RuntimeWorkspace repoId={projectId} tasks={projectTasks.map(({ taskId, title }) => ({ taskId, title }))} />
            ) : view === "system" ? (
              <SystemView activeRepoId={activeRepoId} />
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
        onSelect={handlePaletteSelect}
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

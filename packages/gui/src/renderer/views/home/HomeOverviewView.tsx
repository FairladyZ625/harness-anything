import { useState, useMemo } from "react";
import { ArrowSquareOut, CaretDown, CaretRight, ArrowsClockwise } from "@phosphor-icons/react";
import type { DaemonHomeRepoOverview, DaemonHomeMatter } from "@harness-anything/daemon/protocol";
import { t } from "../../i18n/index.tsx";
import { PageHeader } from "../../components/primitives/PageHeader.tsx";
import { StatusTag, type StatusTone } from "../../components/primitives/StatusTag.tsx";
import { useHomeOverviewQuery } from "./home-overview-data.ts";

export interface HomeOverviewViewProps {
  readonly currentRepoId: string | null;
  readonly onOpenProject: (repoId: string, targetView?: "agenda" | "work" | "overview", taskId?: string) => void;
  readonly onOpenProjectInNewWindow?: (repoId: string) => void;
}

export function HomeOverviewView({ currentRepoId, onOpenProject, onOpenProjectInNewWindow }: HomeOverviewViewProps) {
  const [quietExpanded, setQuietExpanded] = useState(false);
  const overviewQuery = useHomeOverviewQuery();
  const data = overviewQuery.data;
  const isLoading = overviewQuery.isLoading;
  const error = overviewQuery.error instanceof Error ? overviewQuery.error.message : null;

  const repos = useMemo(() => data?.repos ?? [], [data?.repos]);

  // 分流活跃/需要关注仓库 vs 静止健康仓库
  const { activeRepos, quietRepos } = useMemo(() => {
    const active: DaemonHomeRepoOverview[] = [];
    const quiet: DaemonHomeRepoOverview[] = [];
    for (const repo of repos) {
      if (repo.registrationState === "disabled") continue;
      if (repo.isQuiet) {
        quiet.push(repo);
      } else {
        active.push(repo);
      }
    }
    // 排序活跃仓：先排离线/异常，再排有待办的，再排正在跑的
    active.sort((a, b) => {
      const aOffline = a.status === "unavailable" || a.status === "offline" ? 1 : 0;
      const bOffline = b.status === "unavailable" || b.status === "offline" ? 1 : 0;
      if (aOffline !== bOffline) return bOffline - aOffline;
      const aWaiting = a.waitingCount ?? 0;
      const bWaiting = b.waitingCount ?? 0;
      if (aWaiting !== bWaiting) return bWaiting - aWaiting;
      const aRunning = a.runningCount ?? 0;
      const bRunning = b.runningCount ?? 0;
      return bRunning - aRunning;
    });
    return { activeRepos: active, quietRepos: quiet };
  }, [repos]);

  // 全局概览统计
  const totalWaiting = useMemo(() => repos.reduce((sum, r) => sum + (r.waitingCount ?? 0), 0), [repos]);
  const totalRunning = useMemo(() => repos.reduce((sum, r) => sum + (r.runningCount ?? 0), 0), [repos]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="home-overview-view">
      <PageHeader
        title={t("views.homeOverview.title")}
        note={t("views.homeOverview.note")}
        testId="home-overview-header"
        actions={
          <div className="flex items-center gap-2">
            <span className="font-mono ui-micro text-text-muted" data-testid="home-overview-metrics">
              {t("views.homeOverview.summaryMetrics", {
                active: activeRepos.length,
                waiting: totalWaiting,
                running: totalRunning,
                quiet: quietRepos.length,
              })}
            </span>
            <button
              type="button"
              title={t("views.homeOverview.actionRefresh")}
              data-testid="home-overview-refresh"
              onClick={() => overviewQuery.refetch()}
              className="inline-flex items-center justify-center rounded p-1 text-text-muted hover:bg-hover hover:text-text-primary"
            >
              <ArrowsClockwise className={overviewQuery.isFetching ? "animate-spin" : ""} size={16} />
            </button>
          </div>
        }
      />

      {error ? (
        <div
          role="alert"
          className="m-4 rounded border border-status-blocked bg-status-blocked/10 p-3 text-sm text-status-blocked"
          data-testid="home-overview-error"
        >
          {t("views.homeOverview.error", { message: error })}
        </div>
      ) : null}

      <div className="flex flex-col gap-3 p-4" data-testid="home-overview-content">
        {/* 活动与需要关注的仓库列表 (一仓一行，纵向堆叠) */}
        {activeRepos.map((repo) => (
          <RepoRow
            key={repo.repoId}
            repo={repo}
            isCurrent={repo.repoId === currentRepoId}
            onOpenProject={onOpenProject}
            onOpenProjectInNewWindow={onOpenProjectInNewWindow}
          />
        ))}

        {/* 若无任何活动仓库且正在加载 */}
        {isLoading && repos.length === 0 ? (
          <div className="py-12 text-center text-sm text-text-muted" data-testid="home-overview-loading">
            {t("views.homeOverview.loading")}
          </div>
        ) : null}

        {/* 静止仓库底部收纳折叠区 */}
        {quietRepos.length > 0 ? (
          <div
            className="mt-2 flex flex-col rounded-xs border border-border bg-surface"
            data-testid="home-overview-quiet-section"
          >
            <button
              type="button"
              data-testid="home-overview-quiet-toggle"
              onClick={() => setQuietExpanded((prev) => !prev)}
              className="flex w-full items-center justify-between px-3.5 py-2.5 text-left text-sm text-text-muted transition-colors hover:bg-hover"
            >
              <div className="flex items-center gap-2">
                {quietExpanded ? <CaretDown size={14} weight="bold" /> : <CaretRight size={14} weight="bold" />}
                <span className="font-semibold text-text-primary">
                  {t("views.homeOverview.quietTitle", { count: quietRepos.length })}
                </span>
                <span className="ui-micro text-text-faint">{t("views.homeOverview.quietSubtitle")}</span>
              </div>
              <span className="font-mono ui-micro text-text-faint">
                {quietExpanded ? t("views.homeOverview.collapse") : t("views.homeOverview.expand")}
              </span>
            </button>

            {quietExpanded ? (
              <div
                className="flex flex-col divide-y divide-border border-t border-border"
                data-testid="home-overview-quiet-list"
              >
                {quietRepos.map((repo) => (
                  <RepoRow
                    key={repo.repoId}
                    repo={repo}
                    isCurrent={repo.repoId === currentRepoId}
                    onOpenProject={onOpenProject}
                    onOpenProjectInNewWindow={onOpenProjectInNewWindow}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function RepoRow({
  repo,
  isCurrent,
  onOpenProject,
  onOpenProjectInNewWindow,
}: {
  readonly repo: DaemonHomeRepoOverview;
  readonly isCurrent: boolean;
  readonly onOpenProject: (repoId: string, targetView?: "agenda" | "work" | "overview", taskId?: string) => void;
  readonly onOpenProjectInNewWindow?: (repoId: string) => void;
}) {
  const isOffline = repo.status === "unavailable" || repo.status === "offline";
  const hasWaiting = (repo.waitingCount ?? 0) > 0;
  const edgeColor = hasWaiting
    ? "border-l-4 border-l-status-blocked"
    : isOffline
      ? "border-l-4 border-l-status-planned"
      : "";

  return (
    <div
      data-testid={`home-repo-row-${repo.repoId}`}
      className={`group relative flex flex-col gap-2 rounded-xs border border-border bg-surface p-3.5 transition-colors hover:border-text-muted/40 md:flex-row md:items-center md:justify-between ${edgeColor}`}
    >
      {/* 左侧：仓库信息与三个核心指标横排 */}
      <div className="flex min-w-[18rem] flex-col gap-1.5 md:w-1/3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid={`home-repo-name-${repo.repoId}`}
            onClick={() => onOpenProject(repo.repoId)}
            className="truncate text-left text-sm font-semibold text-text-primary hover:text-accent hover:underline"
            title={repo.displayName}
          >
            {repo.displayName}
          </button>

          {isCurrent ? (
            <span
              className="rounded bg-accent/15 px-1.5 py-0.5 font-mono ui-micro text-accent"
              data-testid={`home-repo-current-${repo.repoId}`}
            >
              {t("views.homeOverview.currentTag")}
            </span>
          ) : null}

          {repo.mode === "remote-edge" ? (
            <span className="rounded border border-border px-1 py-px font-mono ui-micro text-text-faint">Edge</span>
          ) : null}

          {isOffline ? <StatusTag tone="bad" label={t("views.homeOverview.statusOffline")} /> : null}
        </div>

        {/* 三个核心指标横排 */}
        <div className="flex items-center gap-3 text-xs" data-testid={`home-repo-metrics-${repo.repoId}`}>
          <div className="flex items-center gap-1">
            <span className="text-text-muted">{t("views.homeOverview.metricWaiting")}:</span>
            <span
              className={`font-mono font-semibold ${
                isOffline ? "text-text-faint" : hasWaiting ? "text-status-blocked" : "text-text-primary"
              }`}
            >
              {isOffline ? "—" : (repo.waitingCount ?? 0)}
            </span>
          </div>

          <span className="text-border">·</span>

          <div className="flex items-center gap-1">
            <span className="text-text-muted">{t("views.homeOverview.metricRunning")}:</span>
            <span
              className={`font-mono font-semibold ${
                isOffline
                  ? "text-text-faint"
                  : (repo.runningCount ?? 0) > 0
                    ? "text-status-active"
                    : "text-text-primary"
              }`}
            >
              {isOffline ? "—" : (repo.runningCount ?? 0)}
            </span>
          </div>

          <span className="text-border">·</span>

          <div className="flex items-center gap-1">
            <span className="text-text-muted">{t("views.homeOverview.metricDelivered")}:</span>
            <span
              className={`font-mono font-semibold ${
                isOffline
                  ? "text-text-faint"
                  : (repo.deliveredCount ?? 0) > 0
                    ? "text-status-done"
                    : "text-text-primary"
              }`}
            >
              {isOffline ? "—" : (repo.deliveredCount ?? 0)}
            </span>
          </div>
        </div>
      </div>

      {/* 右侧：最要紧的 1~3 件事 (人话摘要，各一句话) */}
      <div className="flex min-w-0 flex-1 flex-col gap-1 md:px-4" data-testid={`home-repo-matters-${repo.repoId}`}>
        {repo.topMatters.length === 0 ? (
          <span className="ui-micro text-text-faint">{t("views.homeOverview.noMatters")}</span>
        ) : (
          repo.topMatters.map((matter) => (
            <MatterLine key={matter.key} matter={matter} repoId={repo.repoId} onOpenProject={onOpenProject} />
          ))
        )}
      </div>

      {/* 右端操作按钮 */}
      <div className="flex shrink-0 items-center gap-1 pt-1 md:pt-0">
        <button
          type="button"
          data-testid={`home-repo-open-btn-${repo.repoId}`}
          onClick={() => onOpenProject(repo.repoId)}
          className="rounded border border-border px-2 py-1 ui-micro text-text-primary transition-colors hover:bg-hover"
        >
          {t("views.homeOverview.actionEnter")}
        </button>

        {onOpenProjectInNewWindow ? (
          <button
            type="button"
            title={t("views.homeOverview.actionNewWindow")}
            data-testid={`home-repo-new-window-${repo.repoId}`}
            onClick={() => onOpenProjectInNewWindow(repo.repoId)}
            className="rounded border border-border p-1 text-text-muted transition-colors hover:bg-hover hover:text-text-primary"
          >
            <ArrowSquareOut size={15} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function MatterLine({
  matter,
  repoId,
  onOpenProject,
}: {
  readonly matter: DaemonHomeMatter;
  readonly repoId: string;
  readonly onOpenProject: (repoId: string, targetView?: "agenda" | "work" | "overview", taskId?: string) => void;
}) {
  const toneMap: Record<DaemonHomeMatter["tone"], StatusTone> = {
    danger: "bad",
    warning: "bad",
    active: "active",
    done: "done",
    neutral: "neutral",
  };

  const handleClick = () => {
    if (matter.taskId) {
      onOpenProject(repoId, "work", matter.taskId);
    } else {
      onOpenProject(repoId);
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-1.5 ui-micro">
      <StatusTag tone={toneMap[matter.tone]} label={matter.tag} />
      <button
        type="button"
        onClick={handleClick}
        className="min-w-0 truncate text-left text-text-primary hover:text-accent hover:underline"
        title={matter.text}
      >
        {matter.text}
      </button>
    </div>
  );
}

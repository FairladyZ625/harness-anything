import type { CSSProperties } from "react";
import type { SystemRepoRow } from "../api-client.ts";
import { t } from "../i18n/index.tsx";
import { DenseRow } from "../components/primitives/DenseRow.tsx";
import { StatusTag, TONE_COLOR } from "../components/primitives/StatusTag.tsx";
import { repoCellMeta, repoNeedsAttention } from "../model/repo-state.ts";

/**
 * 项目目录页(标准 §2.5):回答「有哪些项目、哪个进不去、当前在哪个」。每仓一行
 * DenseRow——状态用有底色的 StatusTag,异常仓置顶并带红竖线,正常仓不加强调;
 * 注册被停用的仓只解释不可进入的原因。空目录一行说明,不画大框。
 */
export function HomeView({
  repos,
  currentRepoId,
  onOpenProject,
}: {
  readonly repos: ReadonlyArray<SystemRepoRow>;
  readonly currentRepoId: string | null;
  readonly onOpenProject: (repoId: string) => void;
}) {
  const attention = repos.filter((repo) => repoNeedsAttention(repo)),
    healthy = repos.filter((repo) => !repoNeedsAttention(repo)),
    ordered = [
      ...attention.sort((left, right) => left.repoId.localeCompare(right.repoId)),
      ...healthy.sort((left, right) => {
        if (left.repoId === currentRepoId) return -1;
        if (right.repoId === currentRepoId) return 1;
        const byState = cellRank(left) - cellRank(right);
        return byState !== 0 ? byState : left.repoId.localeCompare(right.repoId);
      }),
    ];
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="home-view">
      <header className="border-b border-border px-4 py-3" data-testid="home-header">
        <div className="flex flex-wrap items-baseline gap-2">
          <h1 className="ui-title font-semibold">{t("views.homeView.title")}</h1>
          <span className="font-mono ui-micro text-text-faint">{repos.length}</span>
        </div>
        <p className="mt-1 ui-meta text-text-faint">{t("views.homeView.summary")}</p>
      </header>
      {ordered.length === 0 ? (
        <p className="px-4 py-3 ui-meta text-text-faint">{t("views.homeView.empty")}</p>
      ) : (
        <div data-testid="home-content" className="w-full p-4">
          {ordered.map((repo) => (
            <HomeRepoRow
              key={repo.repoId}
              repo={repo}
              isCurrent={repo.repoId === currentRepoId}
              onOpen={repo.registrationState === "enabled" ? () => onOpenProject(repo.repoId) : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const cellRank = (repo: SystemRepoRow): number =>
  repo.cellState === "attached" ? 0 : repo.cellState === "warming" ? 1 : 2;

function HomeRepoRow({
  repo,
  isCurrent,
  onOpen,
}: {
  readonly repo: SystemRepoRow;
  readonly isCurrent: boolean;
  readonly onOpen: (() => void) | undefined;
}) {
  const enabled = repo.registrationState === "enabled",
    attention = repoNeedsAttention(repo),
    cell = repoCellMeta(repo.cellState),
    error = repo.unavailableReason ?? repo.lastError,
    // 行强调只给异常仓:左侧 2px 红竖线,不用整块高饱和底色(标准 §3)。
    edge = attention ? ({ "--status-edge": TONE_COLOR.bad } as CSSProperties) : undefined,
    reason = error
      ? error
      : repo.canonicalRoot
        ? repo.canonicalRoot
        : repo.mode === "remote-proxy"
          ? t("views.homeView.remoteProxy")
          : "";
  return (
    <div className="status-edge relative" style={edge} data-testid={`home-repo-${repo.repoId}`}>
      <DenseRow
        tag={<StatusTag tone={cell.tone} label={t(cell.labelKey)} />}
        title={
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate">{repo.displayName || repo.repoId}</span>
            <span className="shrink-0 font-mono ui-micro text-text-faint">{repo.repoId}</span>
            {isCurrent ? (
              <span className="shrink-0 ui-micro font-medium text-accent">{t("views.homeView.current")}</span>
            ) : null}
          </span>
        }
        reason={!enabled ? t("views.homeView.disabled") : reason}
        time={
          repo.lockState === "held"
            ? t("views.homeView.lockHeld")
            : t("views.homeView.queueDepth", { count: repo.queueDepth ?? "—" })
        }
        onClick={onOpen}
      />
    </div>
  );
}

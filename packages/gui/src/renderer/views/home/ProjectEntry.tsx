import type { CSSProperties } from "react";
import type { SystemRepoRow } from "../../api-client.ts";
import { DenseRow } from "../../components/primitives/DenseRow.tsx";
import { StatusTag, TONE_COLOR } from "../../components/primitives/StatusTag.tsx";
import { RepoModeBadge } from "../../components/RepoModeBadge.tsx";
import { BTN } from "../../components/ui/widgets.tsx";
import { useRepoAdminMutations } from "../../connection-data.ts";
import { t } from "../../i18n/index.tsx";
import { projectStatusMeta, repoNeedsAttention, type ProjectActivityRead } from "../../model/repo-state.ts";

/**
 * 项目条目:DenseRow 两行(状态 + 项目名;弱色一行说这个项目正在发生的事或为什么读不到),
 * 等人处理的数量写在状态标签里;其下一行是位置、模式与动作。进入是主动作:点第一行
 * 或「进入」按钮都可以(不依赖悬停)。管理动作只在宿主 bridge 有对应能力时出现
 * (canManage),失败原因就地显示。
 */
export function ProjectEntry({
  repo,
  read,
  isCurrent,
  canManage,
  onOpen,
}: {
  readonly repo: SystemRepoRow;
  readonly read: ProjectActivityRead;
  readonly isCurrent: boolean;
  readonly canManage: boolean;
  readonly onOpen: (repoId: string) => void;
}) {
  const enabled = repo.registrationState === "enabled",
    status = projectStatusMeta(repo, read),
    awaiting = read.state === "ready" ? read.awaitingYou : 0,
    // 强调只给需要处理的条目:坏的红竖线、等人处理的琥珀竖线;正常条目不加(标准 §2.5)。
    edgeTone = enabled && (repoNeedsAttention(repo) || read.state === "failed") ? "bad" : awaiting > 0 ? "wait" : null,
    location = repo.canonicalRoot ?? t("views.homeView.locationRemote", { connection: repo.connectionId });
  return (
    <div
      className="status-edge relative min-w-0"
      style={edgeTone === null ? undefined : ({ "--status-edge": TONE_COLOR[edgeTone] } as CSSProperties)}
      data-testid={`home-repo-${repo.repoId}`}
      data-current={isCurrent || undefined}
    >
      <DenseRow
        relaxed
        selected={isCurrent}
        tag={<StatusTag tone={status.tone} label={t(status.labelKey, { count: awaiting })} />}
        title={
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate">{repo.displayName || repo.repoId}</span>
            {repo.displayName && repo.displayName !== repo.repoId ? (
              <span className="shrink-0 font-mono ui-meta text-text-faint">{repo.repoId}</span>
            ) : null}
            {isCurrent ? (
              <span className="shrink-0 ui-meta font-semibold text-accent">{t("views.homeView.current")}</span>
            ) : null}
          </span>
        }
        reason={activityLine(repo, read)}
        onClick={enabled ? () => onOpen(repo.repoId) : undefined}
      />
      <div className="flex min-h-10 items-center gap-2 px-3.5 pb-1.5">
        <RepoModeBadge mode={repo.mode} />
        <span className="min-w-0 flex-1 truncate font-mono ui-meta text-text-faint" title={location}>
          {location}
        </span>
        {canManage ? <ProjectActions repo={repo} /> : null}
        {enabled && !isCurrent ? (
          <button
            type="button"
            data-testid="home-entry-open"
            className={
              "min-h-10 shrink-0 rounded-md border border-accent/50 px-3 py-1.5 ui-body font-semibold " +
              "text-accent transition-colors duration-100 hover:bg-accent/10"
            }
            onClick={() => onOpen(repo.repoId)}
          >
            {t("views.homeView.actionOpen")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** 第二行:读到了就是数字,没读到就说为什么(按 daemon 状态与 mode 解释,不伪造数字)。 */
function activityLine(repo: SystemRepoRow, read: ProjectActivityRead): string {
  const problem = repo.unavailableReason ?? repo.lastError;
  if (repo.registrationState === "disabled")
    return problem === null ? t("views.homeView.lineDisabled") : `${t("views.homeView.lineDisabled")} ${problem}`;
  if (problem !== null) return problem;
  if (read.state === "failed") return t("views.homeView.lineFailed", { reason: read.reason });
  if (read.state === "loading") return t("views.homeView.lineLoading");
  if (read.state === "unread")
    return repo.cellState === "warming"
      ? t("views.homeView.lineWarming")
      : repo.mode === "remote-proxy"
        ? t("views.homeView.lineRemoteProxy")
        : t("views.homeView.lineNotLoaded");
  const tasks = [
    read.active > 0 ? t("views.homeView.lineActive", { count: read.active }) : null,
    read.inReview > 0 ? t("views.homeView.lineInReview", { count: read.inReview }) : null,
    read.blocked > 0 ? t("views.homeView.lineBlocked", { count: read.blocked }) : null,
  ].filter((part) => part !== null);
  return [
    ...(tasks.length === 0 ? [t("views.homeView.lineNoTasks")] : tasks),
    read.liveAgents === null
      ? t("views.homeView.lineAgentsUnknown")
      : read.liveAgents > 0
        ? t("views.homeView.lineAgents", { count: read.liveAgents })
        : t("views.homeView.lineNoAgents"),
  ].join(" · ");
}

/**
 * 管理动作(daemon.repo.update / daemon.repo.unbind,经已有的 repoAdmin bridge):
 * 启用的项目可停用;停用的项目可启用或移除——移除只对已停用的项目出现,先停用再移除。
 */
function ProjectActions({ repo }: { readonly repo: SystemRepoRow }) {
  const { update, unregister } = useRepoAdminMutations();
  const enabled = repo.registrationState === "enabled",
    busy = update.isPending || unregister.isPending,
    // 被拒绝的原因由 mutation 的 error 带出;下一次动作开始时 react-query 自行清掉。
    feedback = (update.error ?? unregister.error)?.message ?? null,
    button = `${BTN} min-h-10 shrink-0`;
  return (
    <>
      {feedback === null ? null : (
        <span
          className="min-w-0 truncate ui-meta text-status-blocked"
          title={feedback}
          data-testid="home-entry-feedback"
        >
          {feedback}
        </span>
      )}
      <button
        type="button"
        className={button}
        disabled={busy}
        data-testid="home-entry-toggle"
        title={t("views.repositories.repoStateHint")}
        onClick={() => {
          unregister.reset();
          update.mutate({ repoId: repo.repoId, state: enabled ? "disabled" : "enabled" });
        }}
      >
        {enabled ? t("views.homeView.actionDisable") : t("views.homeView.actionEnable")}
      </button>
      {enabled ? null : (
        <button
          type="button"
          className={button}
          disabled={busy}
          data-testid="home-entry-remove"
          title={t("views.repositories.removeRepoHint")}
          onClick={() => {
            update.reset();
            unregister.mutate(repo.repoId);
          }}
        >
          {t("views.homeView.actionRemove")}
        </button>
      )}
    </>
  );
}

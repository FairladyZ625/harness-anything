import { useMutation } from "@tanstack/react-query";
import { useState, type CSSProperties, type ReactNode } from "react";
import { DotsThree } from "@phosphor-icons/react";
import type { SystemRepoRow } from "../../api-client.ts";
import { Popover } from "../../components/Popover.tsx";
import { DenseRow } from "../../components/primitives/DenseRow.tsx";
import { StatusTag, TONE_COLOR } from "../../components/primitives/StatusTag.tsx";
import { RepoModeBadge } from "../../components/RepoModeBadge.tsx";
import { Btn } from "../../components/runtime/parts.tsx";
import { useRepoAdminMutations } from "../../connection-data.ts";
import { t } from "../../i18n/index.tsx";
import { guiHostBridge } from "../../gui-transport.ts";
import { projectStatusMeta, repoNeedsAttention, type ProjectActivityRead } from "../../model/repo-state.ts";
import { relativeTime } from "../../sessions-model.ts";
import { formatTime } from "../../model/time.ts";

type RepoAdmin = ReturnType<typeof useRepoAdminMutations>;

/**
 * 项目条目:DenseRow 两行,不另起第三行——第一行是状态、项目名,行尾弱色给模式与位置
 * (从路径开头截,留住能区分项目的末段;窄到放不下就整段收起,悬停可看全);第二行说这个项目正在发生的事或为什么
 * 读不到。等人处理的数量写在状态标签里。右侧只有一个主动作「进入」(点第一行同效,
 * 不依赖悬停);管理动作收在其后的「⋯」里,只在宿主 bridge 有对应能力时出现
 * (canManage),被拒绝的原因在条目下方就地显示。
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
  readonly onOpen: (repoId: string, targetView?: "agenda" | "work") => void;
}) {
  const directory = guiHostBridge()?.projects,
    canOpenDirectory = directory !== undefined && repo.canonicalRoot !== null && repo.mode !== "remote-proxy",
    openDirectory = useMutation({ mutationFn: () => directory!.openDirectory({ repoId: repo.repoId }) });
  const admin = useRepoAdminMutations(),
    // 被拒绝的原因由 mutation 的 error 带出;下一次动作开始时 react-query 自行清掉。
    feedback = (openDirectory.error ?? admin.update.error ?? admin.unregister.error)?.message ?? null,
    enabled = repo.registrationState === "enabled",
    status = projectStatusMeta(repo, read),
    awaiting = read.state === "ready" ? read.awaitingYou : 0,
    // 强调只给需要处理的条目:坏的红竖线、等人处理的琥珀竖线;正常条目不加(标准 §2.5)。
    edgeTone = enabled && (repoNeedsAttention(repo) || read.state === "failed") ? "bad" : awaiting > 0 ? "wait" : null,
    location = repo.canonicalRoot ?? t("views.homeView.locationRemote", { connection: repo.connectionId }),
    name = repo.displayName || repo.repoId;
  return (
    <div
      className="status-edge relative min-w-0"
      style={edgeTone === null ? undefined : ({ "--status-edge": TONE_COLOR[edgeTone] } as CSSProperties)}
      data-testid={`home-repo-${repo.repoId}`}
      data-current={isCurrent || undefined}
    >
      <div className="flex items-stretch">
        <div className="min-w-0 flex-1">
          <DenseRow
            relaxed
            selected={isCurrent}
            tag={
              enabled && awaiting > 0 ? (
                <button
                  type="button"
                  data-testid="home-entry-awaiting"
                  title={
                    read.state === "ready"
                      ? read.awaitingReply && read.awaitingReply.count > 0
                        ? t("views.homeView.awaitingBreakdown", {
                            count: awaiting - read.awaitingReply.count,
                            reply: `${read.awaitingReply.count}${read.awaitingReply.more ? "+" : ""}`,
                          })
                        : t("views.homeView.awaitingBase", { count: awaiting })
                      : undefined
                  }
                  onClick={() => onOpen(repo.repoId, "agenda")}
                >
                  <StatusTag
                    tone={status.tone}
                    label={t(status.labelKey, {
                      count: `${awaiting}${read.state === "ready" && read.awaitingReply?.more ? "+" : ""}`,
                    })}
                  />
                </button>
              ) : (
                <StatusTag tone={status.tone} label={t(status.labelKey, { count: awaiting })} />
              )
            }
            title={
              // 单行、放不下的整段收起:项目名永远在(过长才省略),其后的仓库 id 与位置要么
              // 整段放得下、要么换到第二行被裁掉,不留半截字符;位置至少有 8rem 才出现。
              <span className="flex h-[1lh] min-w-0 flex-wrap items-baseline gap-x-2 overflow-hidden">
                {enabled ? (
                  <button type="button" className="min-w-0 truncate text-left" onClick={() => onOpen(repo.repoId)}>
                    {name}
                  </button>
                ) : (
                  <span className="min-w-0 truncate">{name}</span>
                )}
                {isCurrent ? (
                  <span className="shrink-0 ui-meta font-semibold text-accent">{t("views.homeView.current")}</span>
                ) : null}
                {repo.displayName && repo.displayName !== repo.repoId ? (
                  <span className="shrink-0 font-mono ui-meta text-text-faint">{repo.repoId}</span>
                ) : null}
                <span className="flex min-w-0 flex-[1_1_8rem] items-baseline justify-end gap-1.5">
                  <RepoModeBadge mode={repo.mode} />
                  <span
                    className="min-w-0 truncate font-mono ui-meta text-text-faint [direction:rtl]"
                    title={location}
                    data-testid="home-entry-location"
                  >
                    <bdi>{location}</bdi>
                  </span>
                </span>
              </span>
            }
            reason={activityLine(repo, read, onOpen)}
            time={
              enabled && read.state === "ready" && read.lastChangedAt !== null ? (
                <time
                  dateTime={read.lastChangedAt}
                  title={formatTime(read.lastChangedAt, { style: "date-time-seconds" }) ?? read.lastChangedAt}
                  data-testid="home-entry-last-activity"
                >
                  {t("views.homeView.lastActivity", { time: relativeTime(read.lastChangedAt) })}
                </time>
              ) : undefined
            }
          />
        </div>
        <div
          className={`flex shrink-0 items-center gap-3 border-t border-border pr-2 ${isCurrent ? "bg-accent/10" : ""}`}
        >
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
          {canManage || canOpenDirectory ? (
            <Popover
              label={t("views.homeView.actionMore")}
              trigger={<DotsThree weight="bold" />}
              triggerClassName={
                "grid size-10 shrink-0 place-items-center rounded-md ui-heading text-text-faint " +
                "transition-colors duration-100 hover:bg-text/5 hover:text-text aria-expanded:bg-text/5 aria-expanded:text-text"
              }
              panelClassName="w-80"
              testId="home-entry-more"
            >
              {(close) => (
                <ProjectActions
                  repo={repo}
                  name={name}
                  liveAgents={read.state === "ready" ? (read.liveAgents ?? 0) : 0}
                  admin={admin}
                  close={close}
                  canManage={canManage}
                  openDirectory={
                    canOpenDirectory
                      ? () => {
                          openDirectory.mutate();
                          close();
                        }
                      : undefined
                  }
                />
              )}
            </Popover>
          ) : null}
        </div>
      </div>
      {feedback === null ? null : (
        <p className="px-3.5 pb-1.5 ui-meta text-status-blocked" data-testid="home-entry-feedback">
          {feedback}
        </p>
      )}
    </div>
  );
}

/** 第二行:读到了就是数字,没读到就说为什么(按 daemon 状态与 mode 解释,不伪造数字)。 */
function activityLine(
  repo: SystemRepoRow,
  read: ProjectActivityRead,
  onOpen: (repoId: string, targetView?: "agenda" | "work") => void,
): ReactNode {
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
  // 重复值不逐行重复(标准 §2.4):agent 只在有的时候写,它是「现在正在发生」的信号,排最前并着色;
  // 「没有进行中的任务」只在整行没别的可说时出现。
  const parts: ReactNode[] = [];
  const link = (key: string, label: string, view: "agenda" | "work") => (
    <button
      key={key}
      type="button"
      className="hover:text-text hover:underline"
      data-testid={`home-entry-${key}`}
      onClick={() => onOpen(repo.repoId, view)}
    >
      {label}
    </button>
  );
  if (read.liveAgents !== null && read.liveAgents > 0)
    parts.push(
      <span key="agents" className="font-semibold" style={{ color: TONE_COLOR.active }} data-testid="home-entry-agents">
        {t("views.homeView.lineAgents", { count: read.liveAgents })}
      </span>,
    );
  if (read.active > 0) parts.push(link("active", t("views.homeView.lineActive", { count: read.active }), "work"));
  if (read.awaitingReply && read.awaitingReply.count > 0)
    parts.push(
      link(
        "reply",
        t("views.homeView.lineAwaitingReply", {
          count: `${read.awaitingReply.count}${read.awaitingReply.more ? "+" : ""}`,
        }),
        "agenda",
      ),
    );
  if (read.inReview > 0)
    parts.push(link("review", t("views.homeView.lineInReview", { count: read.inReview }), "agenda"));
  if (read.blocked > 0) parts.push(t("views.homeView.lineBlocked", { count: read.blocked }));
  if (read.liveAgents === null) parts.push(t("views.homeView.lineAgentsUnknown"));
  return parts.length === 0
    ? t("views.homeView.lineNoTasks")
    : parts.map((part, index) => (
        <span key={index}>
          {index === 0 ? null : " · "}
          {part}
        </span>
      ));
}

/**
 * 「⋯」里的管理动作(daemon.repo.update / daemon.repo.unbind,经已有的 repoAdmin bridge):
 * 启用的项目可停用;停用的项目可启用或移除——移除只对已停用的项目出现,先停用再移除。
 * 停用与移除先在同一个气泡里确认、说清后果,确认后才调用 bridge;启用可逆且无损,直接执行。
 */
function ProjectActions({
  repo,
  name,
  liveAgents,
  admin: { update, unregister },
  close,
  canManage,
  openDirectory,
}: {
  readonly canManage: boolean;
  readonly openDirectory?: () => void;
  readonly repo: SystemRepoRow;
  readonly name: string;
  readonly liveAgents: number;
  readonly admin: RepoAdmin;
  readonly close: () => void;
}) {
  const [confirming, setConfirming] = useState<"disable" | "remove" | null>(null);
  const busy = update.isPending || unregister.isPending,
    item = "block min-h-10 w-full rounded px-2 text-left ui-body text-text hover:bg-text/5 disabled:opacity-45";
  if (confirming === null)
    return (
      <>
        {openDirectory ? (
          <button type="button" className={item} data-testid="home-entry-directory" onClick={openDirectory}>
            {t("views.homeView.actionDirectory")}
          </button>
        ) : null}
        {canManage ? (
          repo.registrationState === "enabled" ? (
            <button
              type="button"
              className={item}
              disabled={busy}
              data-testid="home-entry-disable"
              onClick={() => setConfirming("disable")}
            >
              {t("views.homeView.actionDisable")}…
            </button>
          ) : (
            <>
              <button
                type="button"
                className={item}
                disabled={busy}
                data-testid="home-entry-enable"
                onClick={() => {
                  unregister.reset();
                  update.mutate({ repoId: repo.repoId, state: "enabled" });
                  close();
                }}
              >
                {t("views.homeView.actionEnable")}
              </button>
              <button
                type="button"
                className={item}
                disabled={busy}
                data-testid="home-entry-remove"
                onClick={() => setConfirming("remove")}
              >
                {t("views.homeView.actionRemove")}…
              </button>
            </>
          )
        ) : null}
      </>
    );
  const disabling = confirming === "disable";
  return (
    <div
      role="alertdialog"
      aria-label={t("views.homeView.actionMore")}
      className="p-1"
      data-testid="home-entry-confirm"
    >
      <p className="ui-body font-semibold text-text">
        {t(disabling ? "views.homeView.confirmDisableTitle" : "views.homeView.confirmRemoveTitle", { name })}
      </p>
      {disabling && liveAgents > 0 ? (
        <p className="mt-1 ui-meta font-semibold text-status-blocked" data-testid="home-entry-confirm-agents">
          {t("views.homeView.confirmDisableAgents", { count: liveAgents })}
        </p>
      ) : null}
      <p className="mt-1 ui-meta text-text-muted">
        {t(disabling ? "views.homeView.confirmDisableBody" : "views.homeView.confirmRemoveBody")}
      </p>
      <div className="mt-2.5 flex justify-end gap-2">
        <Btn variant="ghost" testId="home-entry-confirm-cancel" onClick={close}>
          {t("views.homeView.actionCancel")}
        </Btn>
        <Btn
          variant="danger"
          testId="home-entry-confirm-ok"
          disabled={busy}
          onClick={() => {
            if (disabling) {
              unregister.reset();
              update.mutate({ repoId: repo.repoId, state: "disabled" });
            } else {
              update.reset();
              unregister.mutate(repo.repoId);
            }
            close();
          }}
        >
          {t(disabling ? "views.homeView.actionDisable" : "views.homeView.actionRemove")}
        </Btn>
      </div>
    </div>
  );
}

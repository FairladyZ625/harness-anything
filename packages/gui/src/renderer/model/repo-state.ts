import type { AgendaSuccess } from "../api-client.ts";
import type { StatusTone } from "../components/primitives/StatusTag.tsx";
import type { MessageKey } from "../i18n/index.tsx";

/**
 * 仓库 cellState 的统一呈现口径(标准 §3:同一状态同一颜色的有底色标签):
 * HomeView 的目录行与 SystemView 的仓库表共用这一份映射,不在两页各写一套状态色。
 */
const CELL_STATE: Record<string, { readonly tone: StatusTone; readonly labelKey: MessageKey }> = {
  warming: { tone: "wait", labelKey: "views.systemView.stateWarming" },
  attached: { tone: "done", labelKey: "views.systemView.stateAttached" },
  unavailable: { tone: "bad", labelKey: "views.systemView.stateUnavailable" },
  not_loaded: { tone: "neutral", labelKey: "views.systemView.stateNotLoaded" },
};

export function repoCellMeta(cellState: string): { readonly tone: StatusTone; readonly labelKey: MessageKey } {
  return CELL_STATE[cellState] ?? { tone: "neutral", labelKey: "views.systemView.stateNotLoaded" };
}

/** 异常态判定:不可用或带错误信息的仓在目录里置顶并用红竖线强调(标准 §2.5)。 */
export function repoNeedsAttention(repo: {
  readonly cellState: string;
  readonly unavailableReason: string | null;
  readonly lastError: string | null;
}): boolean {
  return repo.cellState === "unavailable" || repo.unavailableReason !== null || repo.lastError !== null;
}

/** 项目管理页判定一个项目所需的 daemon 行字段(SystemRepoRow 的子集)。 */
export interface ProjectRepo {
  readonly repoId: string;
  readonly registrationState: "enabled" | "disabled";
  readonly mode: "local" | "remote-proxy" | "remote-center" | "remote-edge";
  readonly cellState: string;
  readonly unavailableReason: string | null;
  readonly lastError: string | null;
}

/**
 * 一个项目「现在怎么样」的读取结果。数字来自有界读面:议程第一页、工作区摘要
 * (repo.workspace.summary.read,投影里的普查计数)与 runtime 概览(只含未退出的会话)。
 *   - awaitingYou = 已提交待派审的任务 + 待裁的决定,加上议程第一页等待当前人答复的条数;
 *   - awaitingReply.more = 第一页仍有游标，显示 N+，不冒充总数;
 *   - unread = 这个项目没有读(未挂载、远端代理、已停用),页面按 mode 与状态解释原因。
 */
export type ProjectActivityRead =
  | {
      readonly state: "ready";
      readonly lastChangedAt: string | null;
      readonly awaitingReply?: { readonly count: number; readonly more: boolean };
      readonly active: number;
      readonly awaitingYou: number;
      readonly inReview: number;
      readonly blocked: number;
      /** null = runtime 概览没读到;任务数字照常显示,agent 一段如实说明未读到。 */
      readonly liveAgents: number | null;
    }
  | { readonly state: "loading" }
  | { readonly state: "failed"; readonly reason: string }
  | { readonly state: "unread" };

/** 只读已挂载的项目:不为了这个页面去触发挂载,停用与未挂载的项目按状态解释。 */
export function repoReadsActivity(repo: ProjectRepo): boolean {
  return repo.registrationState === "enabled" && repo.cellState === "attached";
}

export function projectActivityRead(
  summary: {
    readonly data?: {
      readonly tasks: {
        readonly lastChangedAt: string | null;
        readonly byStatus: Readonly<Record<"active" | "submitted" | "in_review" | "blocked", number>>;
      };
      readonly decisions: { readonly inboxCount: number };
    };
    readonly error: unknown;
  },
  runtime: {
    readonly data?: { readonly sessions: ReadonlyArray<{ readonly liveness: string }> };
    readonly error: unknown;
  },
  agenda?: AgendaSuccess,
): ProjectActivityRead {
  if (summary.data === undefined)
    return summary.error === null || summary.error === undefined
      ? { state: "loading" }
      : { state: "failed", reason: summary.error instanceof Error ? summary.error.message : String(summary.error) };
  if (runtime.data === undefined && (runtime.error === null || runtime.error === undefined))
    return { state: "loading" };
  const { byStatus } = summary.data.tasks;
  return {
    state: "ready",
    lastChangedAt: summary.data.tasks.lastChangedAt,
    active: byStatus.active,
    awaitingYou: byStatus.submitted + summary.data.decisions.inboxCount + (agenda?.awaitingYou.length ?? 0),
    ...(agenda === undefined
      ? {}
      : { awaitingReply: { count: agenda.awaitingYou.length, more: agenda.page.nextCursor !== null } }),
    inReview: byStatus.in_review,
    blocked: byStatus.blocked,
    liveAgents:
      runtime.data === undefined ? null : runtime.data.sessions.filter(({ liveness }) => liveness === "live").length,
  };
}

export type ProjectGroupId = "attention" | "open" | "disabled";

/** 挂不上、报错、读取失败、有等人处理的事 → 需要处理;停用的沉底;其余可进入。 */
export function projectGroupOf(repo: ProjectRepo, read: ProjectActivityRead): ProjectGroupId {
  if (repo.registrationState === "disabled") return "disabled";
  if (repoNeedsAttention(repo) || read.state === "failed") return "attention";
  return read.state === "ready" && read.awaitingYou > 0 ? "attention" : "open";
}

const cellRank = (repo: ProjectRepo): number =>
  repo.cellState === "attached" ? 0 : repo.cellState === "warming" ? 1 : 2;

/**
 * 分组与组内顺序:需要处理(坏的在前,其次等人处理的数量多的)→ 可进入(当前项目置首,
 * 其后按挂载状态与 id)→ 已停用。组内除当前项目外不按活动量排,读面陆续返回时条目不乱跳。
 */
export function groupProjects<Repo extends ProjectRepo>(
  repos: ReadonlyArray<Repo>,
  currentRepoId: string | null,
  readOf: (repo: Repo) => ProjectActivityRead,
): Readonly<Record<ProjectGroupId, ReadonlyArray<Repo>>> {
  const groups: Record<ProjectGroupId, Repo[]> = { attention: [], open: [], disabled: [] };
  for (const repo of repos) groups[projectGroupOf(repo, readOf(repo))].push(repo);
  const byId = (left: Repo, right: Repo) => left.repoId.localeCompare(right.repoId),
    broken = (repo: Repo) => (repoNeedsAttention(repo) || readOf(repo).state === "failed" ? 0 : 1),
    awaiting = (repo: Repo) => {
      const read = readOf(repo);
      return read.state === "ready" ? read.awaitingYou : 0;
    };
  groups.attention.sort(
    (left, right) => broken(left) - broken(right) || awaiting(right) - awaiting(left) || byId(left, right),
  );
  groups.open.sort((left, right) => {
    if (left.repoId === currentRepoId) return -1;
    if (right.repoId === currentRepoId) return 1;
    return cellRank(left) - cellRank(right) || byId(left, right);
  });
  groups.disabled.sort(byId);
  return groups;
}

/**
 * 条目第一行的状态标签:说这个项目现在的情况,不重复「已附着」这种每行都一样的值
 * (标准 §2.4「重复值不进行」)。已挂载的项目按读到的活动给状态;没读的按 daemon 状态给。
 * 「等你处理」的文案带 {count},调用方传入 awaitingYou。
 */
export function projectStatusMeta(
  repo: ProjectRepo,
  read: ProjectActivityRead,
): { readonly tone: StatusTone; readonly labelKey: MessageKey } {
  if (repo.registrationState === "disabled") return { tone: "cancel", labelKey: "views.homeView.statusDisabled" };
  if (repoNeedsAttention(repo))
    return repo.cellState === "unavailable"
      ? repoCellMeta(repo.cellState)
      : { tone: "bad", labelKey: "views.homeView.statusError" };
  if (read.state === "failed") return { tone: "bad", labelKey: "views.homeView.statusReadFailed" };
  if (read.state === "loading") return { tone: "neutral", labelKey: "views.homeView.statusReading" };
  if (read.state === "unread")
    return repo.mode === "remote-proxy" && repo.cellState === "not_loaded"
      ? { tone: "neutral", labelKey: "views.homeView.statusRemote" }
      : repoCellMeta(repo.cellState);
  if (read.awaitingYou > 0) return { tone: "wait", labelKey: "views.homeView.awaitingYou" };
  return read.active > 0 || (read.liveAgents ?? 0) > 0
    ? { tone: "active", labelKey: "views.homeView.statusActive" }
    : { tone: "neutral", labelKey: "views.homeView.statusIdle" };
}

import type { CloseoutReadiness, EngineId, Freshness, SnapshotStatus, TaskRow } from "./types";
import { isTerminal } from "./types";

export interface TaskFilters {
  query: string;
  module: string;
  engine: EngineId | "all";
  /**
   * 状态多选(D-04):空数组=全部;非空=任务 status 必须命中数组。
   * 替换原 `SnapshotStatus | "all"` 单选语义。
   */
  status: SnapshotStatus[];
  closeout: CloseoutReadiness | "all";
  freshness: Freshness | "all";
  includeArchived: boolean;
  /** 仅看收藏(GUI 本地偏好,不写台账) */
  favoritesOnly: boolean;
}

export const DEFAULT_TASK_FILTERS: TaskFilters = {
  query: "",
  module: "all",
  engine: "all",
  status: [],
  closeout: "all",
  freshness: "all",
  includeArchived: false,
  favoritesOnly: false,
};

export const hasActiveTaskFilters = (filters: TaskFilters) =>
  filters.query.trim() !== "" ||
  filters.module !== "all" ||
  filters.engine !== "all" ||
  filters.status.length > 0 ||
  filters.closeout !== "all" ||
  filters.freshness !== "all" ||
  filters.includeArchived ||
  filters.favoritesOnly;

/**
 * 看板降噪判定(唯一实现,看板与关系图领地共用,不第二份):
 * status=cancelled 或 package disposition 非 active(archived/tombstoned)的 task
 * 默认算噪音。看板入口 = matchesTask 的 !includeArchived 分支;关系图领地入口 =
 * GraphView territory 的「显示已归档」开关(默认关 = 隐藏,task_b92c5138)。
 */
export const isTaskArchiveNoise = (task: Pick<TaskRow, "packageDisposition" | "coordinationStatus">): boolean =>
  /* @gate-identity check-gui-status-judgments/gui-status-033 */
  task.packageDisposition !== "active" ||
  /* @gate-identity check-gui-status-judgments/gui-status-034 */
  task.coordinationStatus === "cancelled";

/**
 * 关系图「重点模式」的种子判定(task_5ba031c2):一个 task 是否默认要看。
 *
 * 判定本体在这里,与看板共用同一组既有判定(isTerminal / isTaskArchiveNoise),
 * 不另立第二份状态词表:
 *   pinned         → 永远是种子(pin 是「我当下正在做的」,与状态正交,归档也不例外);
 *   非终态且非归档  → 开放工作面(planned/active/blocked/in_review/unknown);
 *   最近 N 天有变更 → 刚动过的(含刚收口的 done),否则冷任务折叠成计数徽章。
 * 关系图领地与聚光灯两视图都经 selectGraphFocusSet(graph/focusSet.ts)调它;
 * 看板将来要「只看重点」也调这里,不复制。
 */
export const GRAPH_FOCUS_RECENT_WINDOW_DAYS = 14;

export function isTaskGraphFocusSeed(
  task: Pick<TaskRow, "taskId" | "pinned" | "packageDisposition" | "coordinationStatus" | "lastKnownAt">,
  now: string,
): boolean {
  if (task.pinned === true) return true;
  if (isTaskArchiveNoise(task)) return false;
  if (!isTerminal(task.coordinationStatus)) return true;
  return recentWindowCutoff(now) <= Date.parse(task.lastKnownAt);
}

/** 窗口下界(毫秒);`now` 解析失败(NaN)返回 NaN,比较恒 false → 冷任务折叠,不误收。 */
function recentWindowCutoff(now: string): number {
  const at = Date.parse(now);
  return Number.isNaN(at) ? at : at - GRAPH_FOCUS_RECENT_WINDOW_DAYS * 86_400_000;
}

export function matchesTask(task: TaskRow, filters: TaskFilters, favorites?: ReadonlySet<string>): boolean {
  if (!filters.includeArchived && isTaskArchiveNoise(task)) {
    return false;
  }

  if (filters.favoritesOnly && favorites && !favorites.has(task.taskId)) {
    return false;
  }

  const query = filters.query.trim().toLowerCase();
  if (query) {
    const haystack = [
      task.taskId,
      task.title,
      task.module,
      ...(task.moduleKeys ?? []),
      ...(task.productLines ?? []),
      task.engine,
      task.rawStatus,
      task.coordinationStatus,
      task.closeoutReadiness,
      task.freshness,
    ]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(query)) return false;
  }

  if (filters.module !== "all" && task.module !== filters.module && !task.moduleKeys?.includes(filters.module))
    return false;
  if (filters.engine !== "all" && task.engine !== filters.engine) return false;
  if (
    filters.status.length > 0 &&
    !filters.status.includes(task.coordinationStatus) &&
    !(
      /* @gate-identity check-gui-status-judgments/gui-status-035 */
      (
        task.blocking === "unknown" &&
        /* @gate-identity check-gui-status-judgments/gui-status-036 */
        filters.status.includes("unknown")
      )
    )
  )
    return false;
  if (filters.closeout !== "all" && task.closeoutReadiness !== filters.closeout) return false;
  if (filters.freshness !== "all" && task.freshness !== filters.freshness) return false;

  return true;
}

export const applyTaskFilters = (
  tasks: readonly TaskRow[],
  filters: TaskFilters,
  favorites?: ReadonlySet<string>,
): readonly TaskRow[] => tasks.filter((task) => matchesTask(task, filters, favorites));

export const taskFilterSummary = (filters: TaskFilters): string[] => {
  const parts: string[] = [];
  if (filters.query.trim()) parts.push(`搜索 "${filters.query.trim()}"`);
  if (filters.module !== "all") parts.push(`module=${filters.module}`);
  if (filters.engine !== "all") parts.push(`engine=${filters.engine}`);
  if (filters.status.length > 0) parts.push(`status=${filters.status.join("|")}`);
  if (filters.closeout !== "all") parts.push(`closeout=${filters.closeout}`);
  if (filters.freshness !== "all") parts.push(`freshness=${filters.freshness}`);
  if (filters.includeArchived) parts.push("含归档/取消");
  if (filters.favoritesOnly) parts.push("仅看收藏");
  return parts;
};

/**
 * 收藏排序助手:把收藏的任务排到同组前面(sticky 置顶)。
 * 稳定排序:不改变同 favorites 等级内的原有顺序。
 */
export function sortByFavoritesFirst<T>(
  items: readonly T[],
  getTaskId: (item: T) => string,
  favorites: ReadonlySet<string>,
): T[] {
  const favorited: T[] = [];
  const rest: T[] = [];
  for (const item of items) {
    if (favorites.has(getTaskId(item))) favorited.push(item);
    else rest.push(item);
  }
  return [...favorited, ...rest];
}

/**
 * 台账 pin 排序助手:pin 是 canonical 台账字段(`task/v2.pinned`,经 `ha task pin`
 * 或 GUI 同一动作写入),所以它排在本地收藏之前——「今天当前在做」先于个人偏好。
 * 稳定排序:每个等级内不改变原有顺序。
 */
export function sortByPinAndFavoritesFirst<T>(
  items: readonly T[],
  isPinned: (item: T) => boolean,
  getTaskId: (item: T) => string,
  favorites: ReadonlySet<string>,
): T[] {
  const pinned: T[] = [];
  const favorited: T[] = [];
  const rest: T[] = [];
  for (const item of items) {
    if (isPinned(item)) pinned.push(item);
    else if (favorites.has(getTaskId(item))) favorited.push(item);
    else rest.push(item);
  }
  return [...pinned, ...favorited, ...rest];
}

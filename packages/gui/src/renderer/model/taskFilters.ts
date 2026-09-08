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
  /**
   * 展开冷终态(默认 false = 折叠):终态且非重点种子的行只显形为计数,
   * 判定见 isColdTerminalTask(W8)。pinned 恒可见,与展开状态无关。
   */
  expandColdTerminal: boolean;
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
  expandColdTerminal: false,
};

export const hasActiveTaskFilters = (filters: TaskFilters) =>
  filters.query.trim() !== "" ||
  filters.module !== "all" ||
  filters.engine !== "all" ||
  filters.status.length > 0 ||
  filters.closeout !== "all" ||
  filters.freshness !== "all" ||
  filters.includeArchived ||
  filters.favoritesOnly ||
  filters.expandColdTerminal;

/**
 * 看板降噪判定(唯一实现,看板与关系图领地共用,不第二份):投影的
 * `visibility.noise`(kernel `taskVisibility`:package disposition 非 active,或
 * 已取消)。看板入口 = matchesTask 的 !includeArchived 分支;关系图领地入口 =
 * GraphView territory 的「显示已归档」开关(默认关 = 隐藏,task_b92c5138)。
 */
export const isTaskArchiveNoise = (task: Pick<TaskRow, "visibility">): boolean => task.visibility.noise;

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
  task: Pick<TaskRow, "taskId" | "pinned" | "board" | "visibility" | "lastKnownAt">,
  now: string,
): boolean {
  if (task.pinned === true) return true;
  if (isTaskArchiveNoise(task)) return false;
  if (!isTerminal(task)) return true;
  return recentWindowCutoff(now) <= Date.parse(task.lastKnownAt);
}

/**
 * 看板「冷终态」判定(W8):终态且不在重点种子集里的行默认折叠为计数。判定完全
 * 委托 isTaskGraphFocusSeed(14 天窗口唯一实现,图视图注释里预告的「看板将来调
 * 这里」即此);pinned 在种子判定内恒为真,因此永远可见,与状态正交。
 */
export function isColdTerminalTask(
  task: Pick<TaskRow, "taskId" | "pinned" | "board" | "visibility" | "lastKnownAt">,
  now: string,
): boolean {
  return isTerminal(task) && !isTaskGraphFocusSeed(task, now);
}

/** 单趟把任务分成「默认可见」与「冷终态(折叠为计数)」两组;计数在展开态也要可见。 */
export function partitionColdTerminalTasks<
  T extends Pick<TaskRow, "taskId" | "pinned" | "board" | "visibility" | "lastKnownAt">,
>(tasks: readonly T[], now: string): { visible: T[]; collapsed: T[] } {
  const visible: T[] = [];
  const collapsed: T[] = [];
  for (const task of tasks) (isColdTerminalTask(task, now) ? collapsed : visible).push(task);
  return { visible, collapsed };
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
  // 状态筛选命中协调状态或阻塞评估任一(blocking 的 unknown 由此吸纳进 unknown 档,
  // blocked 档同时给出「带着 active blocking relation」的行)。比较对象是用户筛选
  // 数组与行字段,不是状态词字面量——判定语义由投影字段携带。
  if (
    filters.status.length > 0 &&
    !filters.status.includes(task.coordinationStatus) &&
    !filters.status.some((status) => task.blocking !== undefined && status === task.blocking)
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
  if (filters.expandColdTerminal) parts.push("已展开冷终态");
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

/**
 * 看板/列表共用的默认序(W8):lastKnownAt 倒序(最近动的在前)打底,再过
 * pin → 收藏稳定置顶。同刻任务保持原相对顺序(两步都是稳定排序)。
 */
export function sortByRecentThenPinAndFavoritesFirst<T extends Pick<TaskRow, "taskId" | "pinned" | "lastKnownAt">>(
  items: readonly T[],
  favorites: ReadonlySet<string>,
): T[] {
  return sortByPinAndFavoritesFirst(
    [...items].sort((a, b) => b.lastKnownAt.localeCompare(a.lastKnownAt)),
    (item) => item.pinned === true,
    (item) => item.taskId,
    favorites,
  );
}

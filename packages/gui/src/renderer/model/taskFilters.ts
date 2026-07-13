import type {
  CloseoutReadiness,
  EngineId,
  Freshness,
  SnapshotStatus,
  TaskRow,
} from "./types";
import { t } from "../i18n/core.ts";

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

export function matchesTask(
  task: TaskRow,
  filters: TaskFilters,
  favorites?: ReadonlySet<string>,
): boolean {
  if (
    !filters.includeArchived &&
    (task.packageDisposition !== "active" ||
      task.coordinationStatus === "cancelled")
  ) {
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

  if (filters.module !== "all" && task.module !== filters.module) return false;
  if (filters.engine !== "all" && task.engine !== filters.engine) return false;
  if (filters.status.length > 0 && !filters.status.includes(task.coordinationStatus))
    return false;
  if (filters.closeout !== "all" && task.closeoutReadiness !== filters.closeout)
    return false;
  if (filters.freshness !== "all" && task.freshness !== filters.freshness)
    return false;

  return true;
}

export const applyTaskFilters = (
  tasks: TaskRow[],
  filters: TaskFilters,
  favorites?: ReadonlySet<string>,
) => tasks.filter((task) => matchesTask(task, filters, favorites));

export const taskFilterSummary = (filters: TaskFilters): string[] => {
  const parts: string[] = [];
  if (filters.query.trim()) parts.push(t("model.taskFilters.searchValue", { value: filters.query.trim() }));
  if (filters.module !== "all") parts.push(`module=${filters.module}`);
  if (filters.engine !== "all") parts.push(`engine=${filters.engine}`);
  if (filters.status.length > 0) parts.push(`status=${filters.status.join("|")}`);
  if (filters.closeout !== "all") parts.push(`closeout=${filters.closeout}`);
  if (filters.freshness !== "all") parts.push(`freshness=${filters.freshness}`);
  if (filters.includeArchived) parts.push(t("model.taskFilters.includingArchiveCancel"));
  if (filters.favoritesOnly) parts.push(t("model.taskFilters.viewOnlyCollections"));
  return parts;
};

/**
 * 收藏排序助手:把收藏的任务排到同组前面(sticky 置顶)。
 * 稳定排序:不改变同 favorites 等级内的原有顺序。
 */
export function sortByFavoritesFirst<T>(items: readonly T[], getTaskId: (item: T) => string, favorites: ReadonlySet<string>): T[] {
  const favorited: T[] = [];
  const rest: T[] = [];
  for (const item of items) {
    if (favorites.has(getTaskId(item))) favorited.push(item);
    else rest.push(item);
  }
  return [...favorited, ...rest];
}

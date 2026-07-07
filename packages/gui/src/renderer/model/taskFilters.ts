import type {
  CloseoutReadiness,
  EngineId,
  Freshness,
  SnapshotStatus,
  TaskRow,
} from "./types";

export interface TaskFilters {
  query: string;
  module: string;
  engine: EngineId | "all";
  status: SnapshotStatus | "all";
  closeout: CloseoutReadiness | "all";
  freshness: Freshness | "all";
  includeArchived: boolean;
}

export const DEFAULT_TASK_FILTERS: TaskFilters = {
  query: "",
  module: "all",
  engine: "all",
  status: "all",
  closeout: "all",
  freshness: "all",
  includeArchived: false,
};

export const hasActiveTaskFilters = (filters: TaskFilters) =>
  filters.query.trim() !== "" ||
  filters.module !== "all" ||
  filters.engine !== "all" ||
  filters.status !== "all" ||
  filters.closeout !== "all" ||
  filters.freshness !== "all" ||
  filters.includeArchived;

export function matchesTask(task: TaskRow, filters: TaskFilters): boolean {
  if (
    !filters.includeArchived &&
    (task.packageDisposition !== "active" ||
      task.coordinationStatus === "cancelled")
  ) {
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
  if (filters.status !== "all" && task.coordinationStatus !== filters.status)
    return false;
  if (filters.closeout !== "all" && task.closeoutReadiness !== filters.closeout)
    return false;
  if (filters.freshness !== "all" && task.freshness !== filters.freshness)
    return false;

  return true;
}

export const applyTaskFilters = (tasks: TaskRow[], filters: TaskFilters) =>
  tasks.filter((task) => matchesTask(task, filters));

export const taskFilterSummary = (filters: TaskFilters): string[] => {
  const parts: string[] = [];
  if (filters.query.trim()) parts.push(`搜索 "${filters.query.trim()}"`);
  if (filters.module !== "all") parts.push(`module=${filters.module}`);
  if (filters.engine !== "all") parts.push(`engine=${filters.engine}`);
  if (filters.status !== "all") parts.push(`status=${filters.status}`);
  if (filters.closeout !== "all") parts.push(`closeout=${filters.closeout}`);
  if (filters.freshness !== "all") parts.push(`freshness=${filters.freshness}`);
  if (filters.includeArchived) parts.push("含归档/取消");
  return parts;
};

import type { TaskProjectionRow } from "../../../kernel/src/index.ts";
import type { TaskListFilters } from "../cli/types.ts";

export function filterTaskProjectionRows(
  rows: ReadonlyArray<TaskProjectionRow>,
  filters: TaskListFilters
): ReadonlyArray<TaskProjectionRow> {
  return rows.filter((row) => {
    if (!filters.includeArchived && row.packageDisposition !== "active") return false;
    if (filters.state && !matchesState(row, filters.state)) return false;
    if (filters.moduleKey && row.moduleKey !== filters.moduleKey) return false;
    if (filters.queue && !matchesQueue(row, filters.queue)) return false;
    if (filters.preset && row.preset !== filters.preset) return false;
    if (filters.workKind && row.workKind !== filters.workKind) return false;
    if (filters.riskTier && row.riskTier !== filters.riskTier) return false;
    if (filters.urgency && row.urgency !== filters.urgency) return false;
    if (filters.review && !matchesReview(row, filters.review)) return false;
    if (filters.lesson && !matchesLesson(row, filters.lesson)) return false;
    if (filters.missingMaterials && row.closeoutReadiness !== "missing") return false;
    if (filters.search && !matchesSearch(row, filters.search)) return false;
    return true;
  });
}

function matchesState(row: TaskProjectionRow, state: string): boolean {
  const normalized = normalizeFilter(state);
  return row.canonicalStatus === normalized || row.coordinationStatus === normalized;
}

function matchesQueue(row: TaskProjectionRow, queue: string): boolean {
  const normalized = normalizeFilter(queue);
  return row.coordinationStatus === normalized || row.packageDisposition === normalized;
}

function matchesReview(row: TaskProjectionRow, review: string): boolean {
  const normalized = normalizeFilter(review);
  return row.closeoutReadiness === normalized || row.canonicalStatus === normalized || row.coordinationStatus === normalized;
}

function matchesLesson(row: TaskProjectionRow, lesson: "present" | "missing"): boolean {
  return lesson === "present" ? row.hasLessonCandidates === true : row.hasLessonCandidates !== true;
}

function matchesSearch(row: TaskProjectionRow, search: string): boolean {
  const needle = search.toLocaleLowerCase();
  return [
    row.taskId,
    row.title,
    row.sourcePath,
    row.preset ?? "",
    row.moduleKey ?? "",
    row.moduleTitle ?? "",
    row.createdBy?.name ?? "",
    row.createdBy?.email ?? ""
  ].some((value) => value.toLocaleLowerCase().includes(needle));
}

function normalizeFilter(value: string): string {
  if (value === "review") return "in_review";
  if (value === "done") return "terminal";
  return value;
}

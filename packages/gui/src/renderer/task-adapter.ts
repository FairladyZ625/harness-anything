import type { TaskProjectionRow } from "../api/renderer-dto.ts";
import type { EngineId, Project, TaskRow } from "./model/types.ts";
import { t } from "./i18n/core.ts";

/**
 * Maps a real `sqlite-task-row/v1` projection row onto the prototype's `TaskRow`
 * view model. The enum value spaces (freshness / packageDisposition /
 * closeoutReadiness / source) are identical between kernel and prototype, so
 * they pass through. The board column key uses `canonicalStatus` (the 6-color
 * lifecycle axis) rather than `coordinationStatus` (the coarse open/blocked
 * signal). Fields the projection does not carry (gates, per-task doc index)
 * are left empty — document bodies come from the separate document bridge.
 */

/**
 * Fallback project id used only when daemon-status has not yet returned repos[].
 * Runtime switcher prefers real repoId values from daemon-status/v2.
 */
const REAL_PROJECT_ID = "harness-anything";

const KNOWN_ENGINES: ReadonlySet<string> = new Set(["local", "multica"]);

function toEngineId(lifecycleEngine: string): EngineId {
  return (KNOWN_ENGINES.has(lifecycleEngine) ? lifecycleEngine : "local") as EngineId;
}

function adaptProjectionRow(row: TaskProjectionRow, projectId: string): TaskRow {
  return {
    taskId: row.taskId,
    title: row.title,
    projectId,
    coordinationStatus: row.canonicalStatus,
    rawStatus: row.rawStatus,
    freshness: row.freshness,
    packageDisposition: row.packageDisposition,
    closeoutReadiness: row.closeoutReadiness,
    engine: toEngineId(row.lifecycleEngine),
    source: row.source,
    module: row.moduleTitle ?? row.moduleKey ?? row.vertical ?? "unassigned",
    lastKnownAt: row.updatedAt,
    gates: [],
    docs: [],
    riskTier: row.riskTier,
    urgency: row.urgency,
    parentTaskId: row.parentTaskId,
    attribution: row.attribution
  };
}

/**
 * 沿 parentTaskId 链上溯到根任务 id。投影行以 Map 形式提供(taskId→parentTaskId)。
 * 根任务的 rootTaskId=自身。链中检测到环或指向不存在的 task 时,以当前 task 为根
 * (防御:不无限循环,投影数据不应有环,但前端不能信任输入)。
 */
export function computeRootTaskId(
  taskId: string,
  parentById: ReadonlyMap<string, string | undefined>,
): string {
  let current = taskId;
  const visited = new Set<string>();
  while (true) {
    if (visited.has(current)) return taskId; // 环防御
    visited.add(current);
    const parent = parentById.get(current);
    if (!parent || !parentById.has(parent)) return current;
    current = parent;
  }
}

/**
 * 在 adaptProjectionRow 之上补齐 rootTaskId / rootTitle。两阶段:先建 parentById
 * 查找表,再按表给每个 row 标根与根标题。
 *
 * `projectId` defaults to REAL_PROJECT_ID for single-repo backward compatibility;
 * multi-repo callers pass the active daemon repoId so TaskRow.projectId matches
 * the switcher selection.
 */
export function adaptProjectionRows(
  rows: ReadonlyArray<TaskProjectionRow>,
  projectId: string = REAL_PROJECT_ID
): TaskRow[] {
  const base = rows.map((row) => adaptProjectionRow(row, projectId));
  const parentById = new Map<string, string | undefined>();
  const titleById = new Map<string, string>();
  for (const task of base) {
    parentById.set(task.taskId, task.parentTaskId);
    titleById.set(task.taskId, task.title);
  }
  return base.map((task) => {
    const rootTaskId = computeRootTaskId(task.taskId, parentById);
    const rootTitle = titleById.get(rootTaskId) ?? task.title;
    return { ...task, rootTaskId, rootTitle };
  });
}

/**
 * Single-repo fallback project card used before daemon-status repos[] lands.
 * Prefer `projectFromDaemonRepo` once status is available.
 */
export function buildRealProject(tasks: ReadonlyArray<TaskRow>): Project {
  return {
    id: REAL_PROJECT_ID,
    name: "harness-anything",
    path: t("renderer.taskAdapter.localLedger"),
    preset: "software/coding",
    engines: ["local"],
    watermarkAt: tasks[0]?.lastKnownAt ?? new Date().toISOString(),
    decisionCount: undefined,
    factCount: undefined,
    repoState: "attached"
  };
}

export { REAL_PROJECT_ID };

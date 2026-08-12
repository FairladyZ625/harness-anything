import type { TaskSnapshotProjectionRow } from "../api/renderer-dto.ts";
import type { Project, TaskRow } from "./model/types.ts";

/**
 * Maps the rebuild L2 task snapshot onto the renderer view model. UI-only
 * readiness and freshness fields are derived here; the daemon returns the
 * canonical snapshot without recreating the retired GUI projection schema.
 */

const REAL_PROJECT_ID = "harness-anything";

function adaptProjectionRow(row: TaskSnapshotProjectionRow, projectionStatus: "ready" | "pending"): TaskRow {
  const task = row.snapshot.task!;
  return {
    taskId: row.taskId,
    title: task.title,
    projectId: REAL_PROJECT_ID,
    coordinationStatus: task.status,
    rawStatus: `${task.status}/${task.currentNode}`,
    freshness: projectionStatus === "ready" ? "fresh" : "stale-but-usable",
    packageDisposition: "active",
    closeoutReadiness: task.status === "done" ? "passed" : task.status === "in_review" ? "ready" : "not_required",
    engine: "local",
    source: "snapshot-cache",
    module: "unassigned",
    lastKnownAt: row.updatedAt,
    gates: [],
    docs: []
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
 */
export function adaptProjectionRows(rows: ReadonlyArray<TaskSnapshotProjectionRow>, projectionStatus: "ready" | "pending" = "ready"): TaskRow[] {
  const base = rows.map((row) => adaptProjectionRow(row, projectionStatus));
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

export function buildRealProject(tasks: ReadonlyArray<TaskRow>): Project {
  return {
    id: REAL_PROJECT_ID,
    name: "harness-anything",
    path: "本地台账",
    preset: "software/coding",
    engines: ["local"],
    watermarkAt: tasks[0]?.lastKnownAt ?? new Date().toISOString(),
    decisionCount: undefined,
    factCount: undefined
  };
}

export { REAL_PROJECT_ID };

import type { TaskProjectionRow } from "../api/renderer-dto.ts";
import type { EngineId, Project, TaskRow } from "./model/types.ts";

/**
 * Maps a real `sqlite-task-row/v1` projection row onto the prototype's `TaskRow`
 * view model. The enum value spaces (freshness / packageDisposition /
 * closeoutReadiness / source) are identical between kernel and prototype, so
 * they pass through. The board column key uses `canonicalStatus` (the 6-color
 * lifecycle axis) rather than `coordinationStatus` (the coarse open/blocked
 * signal). Fields the projection does not carry (gates, per-task doc index)
 * are left empty — document bodies come from the separate document bridge.
 */

const REAL_PROJECT_ID = "harness-anything";

const KNOWN_ENGINES: ReadonlySet<string> = new Set(["local", "multica", "github", "linear"]);

function toEngineId(lifecycleEngine: string): EngineId {
  return (KNOWN_ENGINES.has(lifecycleEngine) ? lifecycleEngine : "local") as EngineId;
}

export function adaptProjectionRow(row: TaskProjectionRow): TaskRow {
  return {
    taskId: row.taskId,
    title: row.title,
    projectId: REAL_PROJECT_ID,
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
    spawningDecision: row.parentTaskId
  };
}

export function adaptProjectionRows(rows: ReadonlyArray<TaskProjectionRow>): TaskRow[] {
  return rows.map(adaptProjectionRow);
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

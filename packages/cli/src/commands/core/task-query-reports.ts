import {
  type FactAnchorRow,
  type RelationGraphEdgeRow,
  type TaskProjectionRow
} from "../../../../kernel/src/index.ts";
import type { CliResult, RelationListFilters } from "../../cli/types.ts";

export function buildTaskShowReport(
  task: TaskProjectionRow,
  rows: ReadonlyArray<TaskProjectionRow>,
  edges: ReadonlyArray<RelationGraphEdgeRow>,
  factAnchors: ReadonlyArray<FactAnchorRow>
): Record<string, unknown> {
  const taskRef = `task/${task.taskId}`;
  const taskFactAnchors = factAnchors.filter((anchor) => anchor.taskId === task.taskId);
  const relevantRefs = new Set([taskRef, ...taskFactAnchors.map((anchor) => anchor.factRef)]);
  const relationEdges = edges.filter((edge) => relevantRefs.has(edge.sourceRef) || relevantRefs.has(edge.targetRef));
  const parent = task.parentTaskId ? rows.find((row) => row.taskId === task.parentTaskId) : undefined;
  const children = rows
    .filter((row) => row.parentTaskId === task.taskId)
    .sort((left, right) => left.taskId.localeCompare(right.taskId))
    .map(compactTask);
  return {
    schema: "task-show-report/v1",
    task: {
      ...compactTask(task),
      rawStatus: task.rawStatus,
      coordinationStatus: task.coordinationStatus,
      packageDisposition: task.packageDisposition,
      closeoutReadiness: task.closeoutReadiness,
      lifecycleEngine: task.lifecycleEngine,
      freshness: task.freshness,
      updatedAt: task.updatedAt,
      source: task.source,
      sourcePath: task.sourcePath,
      attribution: task.attribution,
      ...(task.fieldExtensions ? { fieldExtensions: task.fieldExtensions } : {})
    },
    hierarchy: {
      ...(parent ? { parent: compactTask(parent) } : task.parentTaskId ? { missingParentTaskId: task.parentTaskId } : {}),
      children,
      childCount: children.length
    },
    materials: {
      closeoutReadiness: task.closeoutReadiness,
      hasLessonCandidates: task.hasLessonCandidates === true,
      reviewReadiness: "not-projected",
      readSetStatus: "not-projected"
    },
    progress: {
      summary: "not-projected",
      source: "projection"
    },
    relations: {
      taskRef,
      edges: relationEdges,
      summary: summarizeTaskRelations(taskRef, relationEdges)
    },
    evidence: {
      factAnchors: taskFactAnchors,
      factAnchorCount: taskFactAnchors.length
    }
  };
}

export function filterRelations(
  edges: ReadonlyArray<RelationGraphEdgeRow>,
  filters: RelationListFilters
): ReadonlyArray<RelationGraphEdgeRow> {
  return edges.filter((edge) => {
    if (filters.entity && edge.sourceRef !== filters.entity && edge.targetRef !== filters.entity) return false;
    if (filters.source && edge.sourceRef !== filters.source) return false;
    if (filters.target && edge.targetRef !== filters.target) return false;
    if (filters.type && edge.relationType !== filters.type) return false;
    if (filters.state && edge.state !== filters.state) return false;
    return true;
  });
}

export function relationFiltersForReport(filters: RelationListFilters): Record<string, string> {
  return Object.fromEntries(Object.entries(filters).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export function summarizeRelationRows(edges: ReadonlyArray<RelationGraphEdgeRow>): Record<string, unknown> {
  return {
    total: edges.length,
    byState: countBy(edges.map((edge) => edge.state)),
    byType: countBy(edges.map((edge) => edge.relationType))
  };
}

export function summarizeStatus(
  rows: ReadonlyArray<{ readonly packageDisposition: string; readonly coordinationStatus: string }>
): NonNullable<CliResult["summary"]> {
  return {
    taskCount: rows.length,
    byPackageDisposition: countBy(rows.map((row) => row.packageDisposition)),
    byCoordinationStatus: countBy(rows.map((row) => row.coordinationStatus))
  };
}

export function renderTaskTreeRows(
  rows: ReadonlyArray<{ readonly taskId: string; readonly title: string; readonly parentTaskId?: string; readonly canonicalStatus: string }>,
  rootTaskId: string
): ReadonlyArray<{ readonly taskId: string; readonly title: string; readonly status: string; readonly parentTaskId?: string; readonly depth: number }> {
  const byParent = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!row.parentTaskId) continue;
    byParent.set(row.parentTaskId, [...(byParent.get(row.parentTaskId) ?? []), row].sort((a, b) => a.taskId.localeCompare(b.taskId)));
  }
  const byId = new Map(rows.map((row) => [row.taskId, row]));
  const output: Array<{ readonly taskId: string; readonly title: string; readonly status: string; readonly parentTaskId?: string; readonly depth: number }> = [];
  const seen = new Set<string>();
  function visit(taskId: string, depth: number): void {
    if (seen.has(taskId)) return;
    const row = byId.get(taskId);
    if (!row) return;
    seen.add(taskId);
    output.push({
      taskId: row.taskId,
      title: row.title,
      status: row.canonicalStatus,
      ...(row.parentTaskId ? { parentTaskId: row.parentTaskId } : {}),
      depth
    });
    for (const child of byParent.get(taskId) ?? []) visit(child.taskId, depth + 1);
  }
  visit(rootTaskId, 0);
  return output;
}

function compactTask(row: TaskProjectionRow): Record<string, unknown> {
  return {
    taskId: row.taskId,
    title: row.title,
    status: row.canonicalStatus,
    ...(row.parentTaskId ? { parentTaskId: row.parentTaskId } : {}),
    ...(row.workKind ? { workKind: row.workKind } : {}),
    ...(row.riskTier ? { riskTier: row.riskTier } : {}),
    ...(row.urgency ? { urgency: row.urgency } : {}),
    ...(row.vertical ? { vertical: row.vertical } : {}),
    ...(row.preset ? { preset: row.preset } : {}),
    ...(row.profile ? { profile: row.profile } : {}),
    ...(row.moduleKey ? { moduleKey: row.moduleKey } : {}),
    ...(row.moduleTitle ? { moduleTitle: row.moduleTitle } : {}),
    attribution: row.attribution
  };
}

function summarizeTaskRelations(taskRef: string, edges: ReadonlyArray<RelationGraphEdgeRow>): Record<string, number> {
  return {
    total: edges.length,
    active: edges.filter((edge) => edge.state === "active").length,
    outgoing: edges.filter((edge) => edge.sourceRef === taskRef).length,
    incoming: edges.filter((edge) => edge.targetRef === taskRef).length,
    factLinked: edges.filter((edge) => edge.sourceRef.startsWith("fact/") || edge.targetRef.startsWith("fact/")).length
  };
}

function countBy(values: ReadonlyArray<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

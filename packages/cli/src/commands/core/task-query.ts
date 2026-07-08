import path from "node:path";
import { Effect } from "effect";
import {
  checkTaskProjection,
  queryTaskProjection,
  queryTaskSubtree,
  readRelationGraphProjection,
  type FactAnchorRow,
  type RelationGraphEdgeRow,
  type TaskFieldExtensionProjection,
  type TaskProjectionRow
} from "../../../../kernel/src/index.ts";
import { commandRegistry } from "../../cli/command-registry.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult, RelationListFilters } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import { bundledVerticalDefinition } from "../extensions/bundled.ts";

type TaskQueryAction = Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "task-list" | "task-show" | "task-tree" | "relation-list" | "status" }>;

export const runTaskQueryCommand: CommandRunner = (context, command) => {
  const action = command.action as TaskQueryAction;
  if (action.kind === "task-list") {
    return Effect.sync(() => {
      const result = queryTaskProjection({
        rootDir: context.rootDir,
        layoutOverrides: context.layoutOverrides,
        filters: action.filters,
        taskFieldExtensions: activeTaskFieldExtensions()
      });
      return {
        ok: true,
        command: "task-list",
        tasks: result.rows,
        warnings: result.warnings
      } satisfies CliResult;
    });
  }
  if (action.kind === "task-show") {
    return Effect.sync(() => {
      const result = queryTaskProjection({
        rootDir: context.rootDir,
        layoutOverrides: context.layoutOverrides,
        filters: { includeArchived: true },
        taskFieldExtensions: activeTaskFieldExtensions()
      });
      const task = result.rows.find((row) => row.taskId === action.taskId);
      if (!task) {
        return {
          ok: false,
          command: "task-show",
          taskId: action.taskId,
          error: cliError(CliErrorCode.TaskNotFound, `task not found: ${action.taskId}`)
        } satisfies CliResult;
      }
      const graph = readRelationGraphProjection({
        rootDir: context.rootDir,
        layoutOverrides: context.layoutOverrides,
        taskFieldExtensions: activeTaskFieldExtensions()
      });
      const report = buildTaskShowReport(task, result.rows, graph.edges, graph.factAnchors);
      return {
        ok: true,
        command: "task-show",
        taskId: action.taskId,
        path: task.sourcePath,
        warnings: [...result.warnings, ...graph.warnings],
        report
      } satisfies CliResult;
    });
  }
  if (action.kind === "task-tree") {
    return Effect.sync(() => {
      const result = queryTaskSubtree({
        rootDir: context.rootDir,
        layoutOverrides: context.layoutOverrides,
        rootTaskId: action.taskId,
        taskFieldExtensions: activeTaskFieldExtensions()
      });
      const rows = result.rows;
      if (!rows.some((row) => row.taskId === action.taskId)) {
        return {
          ok: false,
          command: "task-tree",
          taskId: action.taskId,
          error: cliError(CliErrorCode.TaskNotFound, `task not found: ${action.taskId}`)
        } satisfies CliResult;
      }
      return {
        ok: true,
        command: "task-tree",
        taskId: action.taskId,
        tasks: renderTaskTreeRows(rows, action.taskId),
        warnings: result.warnings,
        report: { schema: "task-tree-report/v1", rootTaskId: action.taskId, nodeCount: rows.length }
      } satisfies CliResult;
    });
  }
  if (action.kind === "relation-list") {
    return Effect.sync(() => {
      const graph = readRelationGraphProjection({
        rootDir: context.rootDir,
        layoutOverrides: context.layoutOverrides,
        taskFieldExtensions: activeTaskFieldExtensions()
      });
      const relations = filterRelations(graph.edges, action.filters);
      return {
        ok: true,
        command: "relation-list",
        rows: relations.length,
        warnings: graph.warnings,
        report: {
          schema: "relation-list-report/v1",
          filters: relationFiltersForReport(action.filters),
          relations,
          summary: summarizeRelationRows(relations)
        }
      } satisfies CliResult;
    });
  }
  return Effect.sync(() => {
    const result = checkTaskProjection({
      rootDir: context.rootDir,
      layoutOverrides: context.layoutOverrides,
      postMerge: true,
      taskFieldExtensions: activeTaskFieldExtensions()
    });
    return {
      ok: result.ok,
      command: "status",
      rows: result.rows.length,
      warnings: result.warnings,
      report: result.report,
      summary: summarizeStatus(result.rows),
      commands: commandRegistry,
      projectionPath: path.relative(command.rootDir, result.projectionPath).split(path.sep).join("/"),
      error: result.ok ? undefined : cliError(CliErrorCode.StatusCheckFailed, "Harness status has warnings that require attention.")
    } satisfies CliResult;
  });
};

function activeTaskFieldExtensions(): ReadonlyArray<TaskFieldExtensionProjection> {
  return bundledVerticalDefinition()?.entityFieldExtensions ?? [];
}

function buildTaskShowReport(
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
      ...(task.createdBy ? { createdBy: task.createdBy } : {}),
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
    ...(row.moduleTitle ? { moduleTitle: row.moduleTitle } : {})
  };
}

function filterRelations(
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

function relationFiltersForReport(filters: RelationListFilters): Record<string, string> {
  return Object.fromEntries(Object.entries(filters).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function summarizeRelationRows(edges: ReadonlyArray<RelationGraphEdgeRow>): Record<string, unknown> {
  return {
    total: edges.length,
    byState: countBy(edges.map((edge) => edge.state)),
    byType: countBy(edges.map((edge) => edge.relationType))
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

function summarizeStatus(
  rows: ReadonlyArray<{ readonly packageDisposition: string; readonly coordinationStatus: string }>
): NonNullable<CliResult["summary"]> {
  return {
    taskCount: rows.length,
    byPackageDisposition: countBy(rows.map((row) => row.packageDisposition)),
    byCoordinationStatus: countBy(rows.map((row) => row.coordinationStatus))
  };
}

function renderTaskTreeRows(
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

function countBy(values: ReadonlyArray<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

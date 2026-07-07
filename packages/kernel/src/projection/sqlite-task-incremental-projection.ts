import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { createHarnessRuntimeContext, resolveHarnessLayout } from "../layout/index.ts";
import { readScalar } from "../markdown/frontmatter.ts";
import type { RelationGraphEdgeRow } from "./relation-graph-projection.ts";
import { buildRelationGraphProjection } from "./relation-graph-projection.ts";
import { compareDecisionRows, hashDecisionProjectionRows, readDecisionProjectionRowsForPaths } from "./sqlite-decision-source.ts";
import { readRelationGraphRows, tryReadProjectionDatabase } from "./sqlite-projection-store.ts";
import { updateProjectionDatabase } from "./sqlite-projection-update-store.ts";
import { compareRows, hashExactRows, readMarkdownSource, sourcePath, taskEntryToRow } from "./sqlite-task-source.ts";
import { rebuildTaskProjection } from "./sqlite-task-projection.ts";
import type { DecisionProjectionRow, ProjectionReadResult, TaskProjectionOptions, TaskProjectionRow } from "./types.ts";

export function updateTaskProjectionIncrementally(options: TaskProjectionOptions & {
  readonly touchedPaths: ReadonlyArray<string>;
  readonly previousSourceHash?: string;
}): ProjectionReadResult & { readonly mode: "incremental" | "rebuild" | "unchanged" } {
  const rootDir = path.resolve(options.rootDir);
  const runtimeContext = createHarnessRuntimeContext(rootDir, options.layoutOverrides);
  const projectionPath = options.projectionPath ? path.resolve(options.projectionPath) : resolveHarnessLayout(runtimeContext).projectionPath;
  const source = readMarkdownSource(runtimeContext);

  if (!existsSync(projectionPath)) {
    return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
  }

  const existing = tryReadProjectionDatabase(projectionPath, options.taskFieldExtensions);
  if (!existing.ok || !projectionRowsMatchMeta(existing)) {
    return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
  }

  const oldGraph = safeReadRelationGraphRows(projectionPath);
  const newGraph = buildRelationGraphProjection(runtimeContext);
  const affected = affectedProjectionEntities({
    rootDir,
    rootInput: runtimeContext,
    touchedPaths: options.touchedPaths,
    sourceEntries: source.entries,
    existingRows: existing.rows,
    existingDecisionRows: existing.decisionRows,
    oldEdges: oldGraph.relationEdges,
    newEdges: newGraph.edges
  });

  if (existing.meta.sourceHash === source.hash && !hasAffectedProjectionEntities(affected)) {
    return {
      rows: [...existing.rows].sort(compareRows),
      warnings: source.warnings,
      mode: "unchanged"
    };
  }

  if (existing.meta.sourceHash !== source.hash && options.previousSourceHash && existing.meta.sourceHash !== options.previousSourceHash) {
    return { ...rebuildTaskProjection({ rootDir, layoutOverrides: options.layoutOverrides, projectionPath, taskFieldExtensions: options.taskFieldExtensions }), mode: "rebuild" };
  }

  const taskChange = incrementalTaskRows(runtimeContext, source.entries, existing.rows, affected.taskIds, options.taskFieldExtensions);
  const decisionChange = incrementalDecisionRows(runtimeContext, existing.decisionRows, affected.decisionIds, affected.decisionPaths);
  const rowsHash = hashExactRows(taskChange.rows);
  const decisionRowsHash = hashDecisionProjectionRows(decisionChange.rows);

  updateProjectionDatabase(projectionPath, {
    deleteTaskIds: [...taskChange.deleteIds],
    upsertTaskRows: taskChange.currentRows,
    deleteDecisionIds: [...decisionChange.deleteIds],
    upsertDecisionRows: decisionChange.currentRows,
    meta: {
      sourceHash: source.hash,
      rowsHash,
      decisionRowsHash
    },
    graphRows: {
      relationEdges: newGraph.edges,
      coverageRows: newGraph.coverageRows,
      factAnchors: newGraph.factAnchors
    },
    taskFieldExtensions: options.taskFieldExtensions
  });

  return {
    rows: taskChange.rows,
    warnings: source.warnings,
    mode: "incremental"
  };
}

function hasAffectedProjectionEntities(affected: {
  readonly taskIds: ReadonlySet<string>;
  readonly decisionIds: ReadonlySet<string>;
  readonly decisionPaths: ReadonlySet<string>;
}): boolean {
  return affected.taskIds.size > 0 || affected.decisionIds.size > 0 || affected.decisionPaths.size > 0;
}

function projectionRowsMatchMeta(existing: {
  readonly rows: ReadonlyArray<TaskProjectionRow>;
  readonly decisionRows: ReadonlyArray<DecisionProjectionRow>;
  readonly meta: { readonly rowsHash: string; readonly decisionRowsHash?: string };
}): boolean {
  return existing.meta.rowsHash === hashExactRows(existing.rows) &&
    (existing.meta.decisionRowsHash ?? "") === hashDecisionProjectionRows(existing.decisionRows);
}

function safeReadRelationGraphRows(projectionPath: string): {
  readonly relationEdges: ReadonlyArray<RelationGraphEdgeRow>;
} {
  try {
    return readRelationGraphRows(projectionPath);
  } catch {
    return { relationEdges: [] };
  }
}

function incrementalTaskRows(
  rootInput: Parameters<typeof taskEntryToRow>[0],
  entries: ReturnType<typeof readMarkdownSource>["entries"],
  existingRows: ReadonlyArray<TaskProjectionRow>,
  affectedTaskIds: ReadonlySet<string>,
  taskFieldExtensions: TaskProjectionOptions["taskFieldExtensions"]
): {
  readonly rows: ReadonlyArray<TaskProjectionRow>;
  readonly currentRows: ReadonlyArray<TaskProjectionRow>;
  readonly deleteIds: ReadonlySet<string>;
} {
  const currentRows = entries
    .filter((entry) => affectedTaskIds.has(entry.taskId) || affectedTaskIds.has(readScalar(entry.frontmatter, "task_id") || entry.taskId))
    .map((entry) => taskEntryToRow(rootInput, entry, taskFieldExtensions));
  const deleteIds = new Set([...affectedTaskIds, ...currentRows.map((row) => row.taskId)]);
  return {
    rows: [
      ...existingRows.filter((row) => !deleteIds.has(row.taskId)),
      ...currentRows
    ].sort(compareRows),
    currentRows,
    deleteIds
  };
}

function incrementalDecisionRows(
  rootInput: Parameters<typeof readDecisionProjectionRowsForPaths>[0],
  existingRows: ReadonlyArray<DecisionProjectionRow>,
  affectedDecisionIds: ReadonlySet<string>,
  affectedDecisionPaths: ReadonlySet<string>
): {
  readonly rows: ReadonlyArray<DecisionProjectionRow>;
  readonly currentRows: ReadonlyArray<DecisionProjectionRow>;
  readonly deleteIds: ReadonlySet<string>;
} {
  const currentRows = readDecisionProjectionRowsForPaths(rootInput, [...affectedDecisionPaths]);
  const deleteIds = new Set([...affectedDecisionIds, ...currentRows.map((row) => row.decisionId)]);
  return {
    rows: [
      ...existingRows.filter((row) => !deleteIds.has(row.decisionId)),
      ...currentRows
    ].sort(compareDecisionRows),
    currentRows,
    deleteIds
  };
}

function affectedProjectionEntities(input: {
  readonly rootDir: string;
  readonly rootInput: Parameters<typeof resolveHarnessLayout>[0];
  readonly touchedPaths: ReadonlyArray<string>;
  readonly sourceEntries: ReturnType<typeof readMarkdownSource>["entries"];
  readonly existingRows: ReadonlyArray<TaskProjectionRow>;
  readonly existingDecisionRows: ReadonlyArray<DecisionProjectionRow>;
  readonly oldEdges: ReadonlyArray<RelationGraphEdgeRow>;
  readonly newEdges: ReadonlyArray<RelationGraphEdgeRow>;
}): {
  readonly taskIds: ReadonlySet<string>;
  readonly decisionIds: ReadonlySet<string>;
  readonly decisionPaths: ReadonlySet<string>;
} {
  const layout = resolveHarnessLayout(input.rootInput);
  const rootDir = realPathIfExists(input.rootDir);
  const tasksRoot = realPathIfExists(layout.tasksRoot);
  const decisionsRoot = realPathIfExists(layout.decisionsRoot);
  const taskIds = new Set<string>();
  const decisionIds = new Set<string>();
  const decisionPaths = new Set<string>();
  const touchedRelativePaths = new Set(input.touchedPaths.map((filePath) => sourcePath(rootDir, realPathIfExists(filePath))));

  for (const filePath of input.touchedPaths) {
    const resolved = realPathIfExists(filePath);
    const taskSlug = taskSlugForPath(tasksRoot, resolved);
    if (taskSlug) taskIds.add(taskSlug);
    if (path.basename(resolved) === "decision.md" && isPathWithin(decisionsRoot, resolved)) {
      decisionPaths.add(path.join(input.rootDir, sourcePath(rootDir, resolved)));
    }
  }

  for (const entry of input.sourceEntries) {
    const entrySourcePath = sourcePath(rootDir, realPathIfExists(entry.indexPath));
    if ([...touchedRelativePaths].some((relativePath) => relativePath === entrySourcePath || relativePath.startsWith(`${path.posix.dirname(entrySourcePath)}/`))) {
      taskIds.add(entry.taskId);
    }
  }

  for (const row of input.existingRows) {
    if ([...touchedRelativePaths].some((relativePath) => relativePath === row.sourcePath || relativePath.startsWith(`${path.posix.dirname(row.sourcePath)}/`))) {
      taskIds.add(row.taskId);
    }
  }

  for (const row of input.existingDecisionRows) {
    if (touchedRelativePaths.has(row.path)) {
      decisionIds.add(row.decisionId);
      decisionPaths.add(path.join(input.rootDir, row.path));
    }
  }

  for (const edge of [...input.oldEdges, ...input.newEdges]) {
    if (!touchedRelativePaths.has(edge.sourcePath)) continue;
    addEntityRef(edge.sourceRef, taskIds, decisionIds);
    addEntityRef(edge.targetRef, taskIds, decisionIds);
  }

  return { taskIds, decisionIds, decisionPaths };
}

function taskSlugForPath(tasksRoot: string, filePath: string): string | undefined {
  if (!isPathWithin(tasksRoot, filePath)) return undefined;
  const relative = path.relative(tasksRoot, filePath);
  const [slug] = relative.split(path.sep);
  return slug && slug.length > 0 ? slug : undefined;
}

function isPathWithin(parent: string, child: string): boolean {
  const relative = path.relative(realPathIfExists(parent), realPathIfExists(child));
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realPathIfExists(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function addEntityRef(ref: string, taskIds: Set<string>, decisionIds: Set<string>): void {
  const [kind, id] = ref.split("/");
  if (kind === "task" && id) taskIds.add(id);
  if (kind === "decision" && id) decisionIds.add(id);
  if (kind === "fact") {
    const ownerTaskId = ref.split("/")[1];
    if (ownerTaskId) taskIds.add(ownerTaskId);
  }
}

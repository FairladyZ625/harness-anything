import path from "node:path";
import { resolveHarnessLayout } from "../layout/index.ts";
import type { RelationGraphEdgeRow } from "./relation-graph-projection.ts";
import { isDeclaredEntityFile, isPathWithin } from "./projection-path.ts";
import { realPathIfExists } from "./toctou-safe-fs.ts";
import { readMarkdownSource, sourcePath } from "./sqlite-task-source.ts";
import type { DecisionProjectionRow, TaskProjectionRow } from "./types.ts";

export function affectedProjectionEntities(input: {
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
  const authoredRoot = realPathIfExists(layout.authoredRoot);
  const taskIds = new Set<string>();
  const decisionIds = new Set<string>();
  const decisionPaths = new Set<string>();
  const touchedRelativePaths = new Set(input.touchedPaths.map((filePath) => sourcePath(rootDir, realPathIfExists(filePath))));
  const declaredEntityRelativePaths = new Set(input.touchedPaths
    .map(realPathIfExists)
    .filter((filePath) => isDeclaredEntityFile(authoredRoot, filePath))
    .map((filePath) => sourcePath(rootDir, filePath)));
  const taskTouchedRelativePaths = [...touchedRelativePaths]
    .filter((relativePath) => !declaredEntityRelativePaths.has(relativePath));
  const tasksRootRelativePath = sourcePath(rootDir, tasksRoot);
  const taskPackageTouchedRelativePaths = taskTouchedRelativePaths.filter((relativePath) =>
    relativePath === tasksRootRelativePath || relativePath.startsWith(`${tasksRootRelativePath}/`));

  for (const filePath of input.touchedPaths) {
    const resolved = realPathIfExists(filePath);
    const taskSlug = taskSlugForPath(tasksRoot, resolved);
    if (taskSlug && !isDeclaredEntityFile(authoredRoot, resolved)) taskIds.add(taskSlug);
    if (path.basename(resolved) === "decision.md" && isPathWithin(decisionsRoot, resolved)) {
      decisionPaths.add(path.join(input.rootDir, sourcePath(rootDir, resolved)));
    }
  }

  for (const relativePath of taskPackageTouchedRelativePaths) {
    const entry = input.sourceEntries.find((candidate) => {
      const entrySourcePath = sourcePath(path.resolve(input.rootDir), path.resolve(candidate.indexPath));
      return relativePath === entrySourcePath || relativePath.startsWith(`${path.posix.dirname(entrySourcePath)}/`);
    });
    if (entry) taskIds.add(entry.taskId);

    const row = input.existingRows.find((candidate) =>
      relativePath === candidate.sourcePath || relativePath.startsWith(`${path.posix.dirname(candidate.sourcePath)}/`));
    if (row) taskIds.add(row.taskId);
  }

  if (taskPackageTouchedRelativePaths.length > 1) {
    for (const entry of input.sourceEntries) {
      const entrySourcePath = sourcePath(path.resolve(input.rootDir), path.resolve(entry.indexPath));
      if (taskPackageTouchedRelativePaths.some((relativePath) => relativePath === entrySourcePath || relativePath.startsWith(`${path.posix.dirname(entrySourcePath)}/`))) {
        taskIds.add(entry.taskId);
      }
    }

    for (const row of input.existingRows) {
      if (taskPackageTouchedRelativePaths.some((relativePath) => relativePath === row.sourcePath || relativePath.startsWith(`${path.posix.dirname(row.sourcePath)}/`))) {
        taskIds.add(row.taskId);
      }
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

  for (const row of input.existingDecisionRows) {
    if (decisionIds.has(row.decisionId)) decisionPaths.add(path.join(input.rootDir, row.path));
  }

  return { taskIds, decisionIds, decisionPaths };
}

function taskSlugForPath(tasksRoot: string, filePath: string): string | undefined {
  if (!isPathWithin(tasksRoot, filePath)) return undefined;
  const relative = path.relative(tasksRoot, filePath);
  const [slug] = relative.split(path.sep);
  return slug && slug.length > 0 ? slug : undefined;
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

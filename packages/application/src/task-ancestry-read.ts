import { deriveTaskReadSet, type TaskProjection } from "@harness-anything/kernel";

/** Follow only parent IDs. Each projection read is checked by the caller against its serving cut. */
export function readTaskAncestry(
  projection: Pick<TaskProjection, "readTaskIndex" | "readDocumentMetadata">,
  taskId: string,
) {
  const rows: ReturnType<TaskProjection["readTaskIndex"]>["rows"][number][] = [],
    reads: ReturnType<TaskProjection["readTaskIndex"]>[] = [],
    visited = new Set<string>();
  let currentId: string | null = taskId;
  while (currentId !== null) {
    if (visited.has(currentId)) throw new Error(`Task ancestry contains a cycle at ${currentId}.`);
    visited.add(currentId);
    const read = projection.readTaskIndex({ taskIds: [currentId] });
    reads.push(read);
    const row: ReturnType<TaskProjection["readTaskIndex"]>["rows"][number] | undefined = read.rows.find(
      (entry) => entry.taskId === currentId,
    );
    if (row === undefined) {
      if (currentId !== taskId) throw new Error(`Required ancestor ${currentId} is missing from the projection.`);
      break;
    }
    if (currentId !== taskId) rows.push(row);
    currentId = row.parentTaskId;
  }
  const cut = reads[0]!;
  const planReads = rows.map((row) =>
    row.packagePath === null ? null : projection.readDocumentMetadata(`${row.packagePath}/task_plan.md`),
  );
  const ancestors = rows.map((row, index) => ({
    ...row,
    contentVersion: planReads[index]?.document?.workspaceRevision ?? null,
    documentAvailable: planReads[index]?.document != null,
  }));
  const readSet = deriveTaskReadSet({
    taskRef: `task/${taskId}`,
    edges: [],
    counterparts: new Map(),
    ancestors,
    projectionCut: { status: cut.status, watermark: cut.watermark, sourceRevision: cut.sourceRevision },
  });
  return { rows, ancestors, reads: [...reads, ...planReads.filter((read) => read !== null)], readSet };
}

import {
  deriveTaskReadSet,
  taskReadSetRelationCandidates,
  parseEntityRef,
  type TaskProjection,
  type TaskReadSet,
  type TaskReadSetCounterpart,
} from "@harness-anything/kernel";
import { readTaskAncestry } from "./task-ancestry-read.ts";

/** The read side this assembler needs; it writes nothing and takes no lease. */
export type TaskReadSetProjection = Pick<
  TaskProjection,
  "readRelationQuery" | "readEntityVersionWitness" | "readTaskIndex" | "readDocumentMetadata"
>;

/**
 * Assemble one task's read set from the parent chain and canonical relation projection at one cut.
 * This layer gathers indexed parents, plan metadata, active edges, and counterpart witnesses,
 * and hands those inputs to the kernel. Every judgment (inclusion, ordering, `required`, `authority`, `blocked`)
 * stays in `deriveTaskReadSet`, and nothing here is written back to the task package.
 */
export function readTaskReadSet(
  projection: TaskReadSetProjection,
  taskId: string,
  ancestry = readTaskAncestry(projection, taskId),
): TaskReadSet {
  const taskRef = `task/${taskId}`,
    relations = projection.readRelationQuery({ entity: taskRef, state: "active" }),
    edges = taskReadSetRelationCandidates(relations.rows),
    counterparts = new Map<string, TaskReadSetCounterpart>();
  for (const read of ancestry.reads) {
    if (
      read.status !== relations.status ||
      read.watermark !== relations.watermark ||
      read.sourceRevision !== relations.sourceRevision
    )
      throw new Error("Task read set spans multiple event projection cuts.");
  }
  for (const row of edges) {
    const entityRef = row.sourceRef === taskRef ? row.targetRef : row.sourceRef;
    if (entityRef === taskRef || counterparts.has(entityRef)) continue;
    const parsed = parseEntityRef(entityRef);
    const taskIndex = parsed?.kind === "task" ? projection.readTaskIndex({ taskIds: [parsed.id] }) : null;
    if (
      taskIndex &&
      (taskIndex.status !== relations.status ||
        taskIndex.watermark !== relations.watermark ||
        taskIndex.sourceRevision !== relations.sourceRevision)
    )
      throw new Error("Task read set spans multiple event projection cuts.");
    counterparts.set(entityRef, {
      witness: projection.readEntityVersionWitness(entityRef),
      ...(parsed?.kind === "task"
        ? { packagePath: taskIndex?.rows.find((row) => row.taskId === parsed.id)?.packagePath ?? null }
        : {}),
    });
  }
  const input = {
    taskRef,
    edges,
    ancestors: ancestry.ancestors,
    counterparts,
    projectionCut: {
      status: relations.status,
      watermark: relations.watermark,
      sourceRevision: relations.sourceRevision,
    },
  };
  const initial = deriveTaskReadSet(input);
  for (const entry of initial.entries) {
    if (!entry.required || entry.whyIncluded.source !== "task-relation" || entry.locator === null) continue;
    const counterpart = counterparts.get(entry.entityRef);
    if (counterpart === undefined) continue;
    const path = parseEntityRef(entry.entityRef)?.kind === "task" ? `${entry.locator}/task_plan.md` : entry.locator;
    const read = projection.readDocumentMetadata(path);
    if (
      read.status !== relations.status ||
      read.watermark !== relations.watermark ||
      read.sourceRevision !== relations.sourceRevision
    )
      throw new Error("Task read set spans multiple event projection cuts.");
    counterparts.set(entry.entityRef, {
      ...counterpart,
      documentPath: path,
      documentAvailable: read.document !== null,
    });
  }
  return deriveTaskReadSet(input);
}

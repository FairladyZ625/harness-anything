import {
  deriveTaskReadSet,
  parseEntityRef,
  type TaskProjection,
  type TaskReadSet,
  type TaskReadSetCounterpart,
} from "../../kernel/src/index.ts";

/** The read side this assembler needs; it writes nothing and takes no lease. */
export type TaskReadSetProjection = Pick<TaskProjection, "read" | "readRelationQuery" | "readEntityVersionWitness">;

/**
 * Assemble one task's read set from the canonical relation projection at a single cut.
 * This layer only gathers inputs — the active edges the relation query authority already
 * serves to `ha relation list`, plus one entity witness per counterpart — and hands them
 * to the kernel. Every judgment (inclusion, ordering, `required`, `authority`, `blocked`)
 * stays in `deriveTaskReadSet`, and nothing here is written back to the task package.
 */
export function readTaskReadSet(projection: TaskReadSetProjection, taskId: string): TaskReadSet {
  const taskRef = `task/${taskId}`,
    relations = projection.readRelationQuery({ entity: taskRef, state: "active" }),
    counterparts = new Map<string, TaskReadSetCounterpart>();
  for (const row of relations.rows) {
    const entityRef = row.sourceRef === taskRef ? row.targetRef : row.sourceRef;
    if (entityRef === taskRef || counterparts.has(entityRef)) continue;
    const parsed = parseEntityRef(entityRef);
    counterparts.set(entityRef, {
      witness: projection.readEntityVersionWitness(entityRef),
      ...(parsed?.kind === "task" ? { packagePath: projection.read(parsed.id).packagePath } : {}),
    });
  }
  return deriveTaskReadSet({
    taskRef,
    edges: relations.rows,
    counterparts,
    projectionCut: {
      status: relations.status,
      watermark: relations.watermark,
      sourceRevision: relations.sourceRevision,
    },
  });
}

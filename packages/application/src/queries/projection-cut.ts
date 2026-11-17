import { isDeepStrictEqual } from "node:util";
import type { TaskRelationProjectionRead } from "@harness-anything/kernel";

/**
 * The cut a read observed. Kept in its own module: dispatch-time consumers need it without
 * importing the task query surface, which itself reads dispatch lineage.
 */
export type ProjectionCut = Pick<TaskRelationProjectionRead, "status" | "watermark" | "sourceRevision">;

export function projectionCut(read: ProjectionCut): ProjectionCut {
  return {
    status: read.status,
    watermark: read.watermark,
    sourceRevision: read.sourceRevision,
  };
}

export function requireSameProjectionCut(surface: string, reads: readonly ProjectionCut[]): ProjectionCut {
  const basis = reads[0];
  if (basis === undefined) throw new Error(`${surface} requires an event projection cut.`);
  for (const read of reads.slice(1))
    if (!isDeepStrictEqual(projectionCut(read), projectionCut(basis)))
      throw new Error(`${surface} spans multiple event projection cuts.`);
  return projectionCut(basis);
}

import {
  relationIsCurrent,
  stackedDeliveryBaseline,
  type ExecutionDeliveryBaseline,
  type TaskProjection,
} from "@harness-anything/kernel";
import { cellCodedError } from "./repo-cell-errors.ts";

/** Re-evaluated inside the center write queue after the checkout has prepared this exact anchor. */
export function resolveStackedTaskBaseline(
  projection: TaskProjection,
  taskId: string,
  stackOn?: string,
): ExecutionDeliveryBaseline | undefined {
  const source = projection.read(taskId),
    execution = source.snapshot.executions.findLast(
      (candidate) => candidate.iteration === source.snapshot.task?.iteration,
    ),
    observed = execution?.schema === "execution/v1" ? execution.deliveryBaseline : undefined,
    frozen = observed?.kind === "commit" && observed.stackOn ? observed : undefined;
  if (stackOn === undefined && frozen === undefined) return undefined;
  const upstreamId = stackOn ?? (frozen?.kind === "commit" ? frozen.stackOn?.taskId : undefined);
  if (!upstreamId || upstreamId === taskId)
    throw cellCodedError("invalid_proof", "Stack start requires a distinct upstream task.");
  const target = projection.read(upstreamId),
    relations = projection.readTaskDependencyClosure([`task/${taskId}`]),
    reads = [source, target, relations],
    cuts = new Set(reads.map(({ watermark, sourceRevision }) => `${watermark}/${sourceRevision}`)),
    declared = relations.rows.some(
      (edge) =>
        edge.sourceRef === `task/${taskId}` &&
        edge.targetRef === `task/${upstreamId}` &&
        edge.relationType === "depends-on" &&
        edge.direction === "directed" &&
        relationIsCurrent(edge),
    ),
    baseline = stackedDeliveryBaseline(target.snapshot);
  if (!reads.every(({ status }) => status === "ready") || cuts.size !== 1 || !declared || !baseline)
    throw cellCodedError(
      "invalid_proof",
      "Stack start requires a current depends-on and a consented approved upstream cut on one ready projection.",
    );
  if (
    frozen?.kind === "commit" &&
    baseline.kind === "commit" &&
    (frozen.commitSha !== baseline.commitSha ||
      frozen.stackOn?.taskId !== baseline.stackOn?.taskId ||
      frozen.stackOn?.executionId !== baseline.stackOn?.executionId)
  )
    throw cellCodedError("invalid_proof", "The frozen stacked delivery no longer matches the upstream current cut.");
  return baseline;
}

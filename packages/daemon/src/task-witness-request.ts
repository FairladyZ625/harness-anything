import { currentGateRun, gateAppliesToSubmission, isRetiredCiRequirement } from "@harness-anything/kernel";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { DaemonTaskWitnessRunResult } from "./protocol/daemon-protocol.contract.ts";

export interface TaskWitnessRequest {
  readonly taskId: string;
  readonly executionId: string;
  readonly gateId: string;
}

/** Only the frozen submission selects executable code and subjects. The caller supplies identities. */
export function readTaskWitnessRequest(cell: RepoCellOperationalContext, request: TaskWitnessRequest) {
  const snapshot = cell.projection.read(request.taskId).snapshot,
    execution = snapshot.executions.find(
      (value) => value.executionId === request.executionId && value.iteration === snapshot.task?.iteration,
    );
  if (
    !snapshot.task ||
    !["submitted", "in_review"].includes(snapshot.task.status) ||
    execution?.schema !== "execution/v1" ||
    !execution.submission
  )
    throw cell.cellCodedError("gate_run_stale", "A current submitted execution is required.");
  const requirement = execution.submission.completionContract.gates.find((gate) => gate.gateId === request.gateId);
  if (
    !requirement ||
    requirement.witness.kind !== "command" ||
    !gateAppliesToSubmission(requirement, execution.submission) ||
    isRetiredCiRequirement(request.gateId, requirement)
  )
    throw cell.cellCodedError("invalid_command", "The frozen gate has no applicable command completion source.");
  const run = currentGateRun(execution, request.gateId),
    witness = snapshot.gateWitnesses.findLast(
      (value) =>
        run !== undefined &&
        value.executionId === execution.executionId &&
        value.gateId === request.gateId &&
        value.provenance?.runId === run?.runId &&
        value.provenance?.claimFence === run?.claimFence,
    );
  return {
    snapshot,
    execution,
    result: {
      taskId: request.taskId,
      executionId: request.executionId,
      gateId: request.gateId,
      witnessId: witness?.witnessId ?? null,
      result: run?.result ?? null,
      diagnostic: run?.diagnostic ?? "Completion source has not been claimed.",
      runId: run?.runId ?? null,
      state: run?.state ?? null,
      availability: run?.availability ?? null,
    } satisfies DaemonTaskWitnessRunResult["witness"],
  };
}

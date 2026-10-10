import { claimGateRun, currentGateRun, gateRunError, replaceGateRun, settleGateRun, type GateRun } from "./gate-run.ts";
import { envelope, execution } from "./task-lifecycle-contract-support.ts";
import { compileTaskLifecycleWrite, type LifecycleDocumentState } from "./task-lifecycle-publication.ts";
import type { GateRunChangedEvent } from "./task-lifecycle-event.ts";
import { validateTaskEvent } from "./task-lifecycle-event.ts";
import type { TaskLifecycleSnapshot } from "./task-lifecycle.contract.ts";
import { TaskLifecycleContractError } from "./task-lifecycle.contract.ts";
import type { ActorAxes } from "./task.ts";
import type { WriteSource } from "./write-chain.contract.ts";
import { stableStringify } from "../integrity/stable-hash.ts";

export function replayGateRunChange(
  snapshot: TaskLifecycleSnapshot,
  event: GateRunChangedEvent,
): TaskLifecycleSnapshot {
  const current = execution(snapshot, event.payload.execution.executionId),
    run = event.payload.execution.gateRuns.find((candidate) => candidate.runId === event.payload.runId);
  if (
    !snapshot.task ||
    !["submitted", "in_review"].includes(snapshot.task.status) ||
    !current?.submission ||
    !run ||
    stableStringify(snapshot.task) !== stableStringify(event.payload.task)
  )
    throw gateRunError("gate_run_stale", "Gate run action requires the current submitted Task and Execution.");
  const requirement = current.submission.completionContract.gates.find((gate) => gate.gateId === run.gateId);
  if (!requirement) throw gateRunError("gate_run_stale", "Run gate is absent from the frozen contract.");
  let expected: GateRun;
  if (event.payload.operation === "claim") {
    expected = claimGateRun({
      execution: current,
      repoId: run.repoId,
      requirement,
      runId: run.runId,
      claimFence: event.workspaceRevision,
      actor: run.actor,
      occurredAt: event.occurredAt,
      expiresAt: run.expiresAt,
      ...(run.supersedesRunId ? { rerun: { runId: run.supersedesRunId, reason: run.diagnostic } } : {}),
    });
  } else if (event.payload.operation === "settle") {
    expected = settleGateRun({
      execution: current,
      runId: run.runId,
      claimFence: run.claimFence,
      actor: event.actor,
      occurredAt: event.occurredAt,
      outcome: { availability: "unavailable", result: null, diagnostic: run.diagnostic },
    });
  } else {
    const prior = currentGateRun(current, run.gateId);
    if (!prior || prior.runId !== run.runId || prior.state === "cancelled" || !run.diagnostic.trim())
      throw gateRunError("gate_run_stale", "Revoke must name the current run and a reason.");
    expected = {
      ...prior,
      state: "cancelled",
      result: null,
      availability: null,
      settledAt: event.occurredAt,
      diagnostic: run.diagnostic,
    };
  }
  const updated = replaceGateRun(current, expected);
  if (stableStringify(updated) !== stableStringify(event.payload.execution))
    throw gateRunError("gate_run_conflict", "Gate run event changed fields outside the accepted transition.");
  return {
    ...snapshot,
    revision: event.workspaceRevision,
    executions: snapshot.executions.map((value) => (value.executionId === updated.executionId ? updated : value)),
  };
}
export function compileGateRunChange(input: {
  readonly snapshot: TaskLifecycleSnapshot;
  readonly executionId: string;
  readonly run: GateRun;
  readonly operation: "claim" | "settle" | "revoke";
  readonly actor: ActorAxes;
  readonly source: WriteSource;
  readonly opId: string;
  readonly eventId: string;
  readonly workspaceRevision: number;
  readonly occurredAt: string;
  readonly packagePath: string | null;
  readonly currentDocuments: readonly LifecycleDocumentState[];
}) {
  const current = execution(input.snapshot, input.executionId);
  if (!current || !input.snapshot.task || input.workspaceRevision <= input.snapshot.revision)
    throw gateRunError("gate_run_stale", "The gate run's aggregate cut is no longer current.");
  const event = envelope<GateRunChangedEvent>({ ...input, taskId: input.snapshot.task.taskId }, "gate_run_changed", {
    task: input.snapshot.task,
    execution: replaceGateRun(current, input.run),
    runId: input.run.runId,
    operation: input.operation,
  });
  const issues = validateTaskEvent(event);
  if (issues.length) throw new TaskLifecycleContractError("invalid_schema", issues);
  const snapshot = replayGateRunChange(input.snapshot, event);
  return compileTaskLifecycleWrite({
    event,
    snapshot,
    packagePath: input.packagePath,
    currentDocuments: input.currentDocuments,
  });
}

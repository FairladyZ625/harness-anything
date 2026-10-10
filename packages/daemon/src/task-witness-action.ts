import { createHash } from "node:crypto";
import {
  claimGateRun,
  compileGateRunChange,
  currentGateRun,
  isSamePerson,
  settleGateRun,
  type CompletionEvidenceV1,
  type GateRun,
  type WriteReceiptDraft,
} from "@harness-anything/kernel";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";

/** An in-process source invocation, never supplied by a transport or execution credential. */
export const centerWitnessAction = Symbol("centerWitnessAction");
export function runTaskWitnessAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceiptDraft {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    read = cell.projection.read(taskId),
    snapshot = read.snapshot,
    task = snapshot.task,
    execution = snapshot.executions.find(
      (value) => value.executionId === action.executionId && value.iteration === task?.iteration,
    ),
    center = (action as Record<symbol, unknown>)[centerWitnessAction] === true;
  if (
    !task ||
    !execution ||
    execution.schema !== "execution/v1" ||
    !execution.submission ||
    !["submitted", "in_review"].includes(task.status)
  )
    throw cell.cellCodedError("gate_run_stale", "Gate actions require a current submitted execution.");
  if (
    !center &&
    (!(action.kind === "task-witness-revoke" || action.kind === "task-witness-rerun") ||
      binding.actor.executor !== null ||
      !isSamePerson(task.createdBy, binding.actor))
  )
    throw cell.cellCodedError(
      "actor_unauthorized",
      "Task execution credentials cannot claim or publish completion witnesses; only the center source host can do so.",
    );
  const gateId = cell.requiredCellText(action.gateId, "gateId"),
    requirement = execution.submission.completionContract.gates.find((gate) => gate.gateId === gateId);
  if (!requirement || requirement.witness.kind === "internal" || requirement.witness.kind === "manual")
    throw cell.cellCodedError("invalid_command", "The frozen gate has no automated source run.");
  const opId = cell.operationId(action, binding, cell.input.repoId, snapshot.revision),
    workspaceRevision = (cell.store.readHead()?.revision ?? 0) + 1,
    occurredAt = cell.now();
  let run: GateRun, operation: "claim" | "settle" | "revoke";
  if (action.kind === "task-witness-claim" || action.kind === "task-witness-rerun") {
    const prior = currentGateRun(execution, gateId);
    if (prior && action.kind === "task-witness-claim")
      return { outcome: "no_changes", opId, revision: snapshot.revision, evidence: JSON.stringify({ run: prior }) };
    run = claimGateRun({
      execution,
      repoId: cell.input.repoId,
      requirement,
      runId: `gate-${opId}`,
      claimFence: workspaceRevision,
      actor: {
        principal: task.createdBy.principal,
        executor: { kind: "agent", id: `completion-source:${requirement.witness.adapterId}` },
      },
      occurredAt,
      expiresAt: new Date(Date.parse(occurredAt) + 60 * 60 * 1000).toISOString(),
      ...(action.kind === "task-witness-rerun"
        ? {
            rerun: {
              runId: cell.requiredCellText(action.runId, "runId"),
              reason: cell.requiredCellText(action.reason, "reason"),
            },
          }
        : {}),
    });
    operation = "claim";
  } else if (action.kind === "task-witness-settle") {
    if (action.evidence !== undefined)
      return cell.publishGateWitness(
        taskId,
        execution.executionId,
        snapshot,
        read.packagePath,
        binding,
        action.evidence as CompletionEvidenceV1,
      );
    run = settleGateRun({
      execution,
      runId: cell.requiredCellText(action.runId, "runId"),
      claimFence: Number(action.claimFence),
      actor: binding.actor,
      occurredAt,
      outcome: {
        availability: "unavailable",
        result: null,
        diagnostic: cell.requiredCellText(action.diagnostic, "diagnostic"),
      },
    });
    operation = "settle";
  } else {
    const prior = currentGateRun(execution, gateId);
    if (!prior || prior.runId !== action.runId || prior.state === "cancelled")
      throw cell.cellCodedError("gate_run_stale", "Revoke requires the current gate run.");
    run = {
      ...prior,
      state: "cancelled",
      settledAt: occurredAt,
      result: null,
      availability: null,
      diagnostic: cell.requiredCellText(action.reason, "reason"),
    };
    operation = "revoke";
  }
  const paths = read.packagePath
      ? [`${read.packagePath}/INDEX.md`, `${read.packagePath}/executions/${execution.executionId}.md`]
      : [],
    compiled = compileGateRunChange({
      snapshot,
      executionId: execution.executionId,
      run,
      operation,
      actor: binding.actor,
      source: binding.source,
      opId,
      eventId: `event-${createHash("sha256").update(opId).digest("hex")}`,
      workspaceRevision,
      occurredAt,
      packagePath: read.packagePath,
      currentDocuments: paths.flatMap((target) => {
        const document = cell.projection.readDocument(target).document;
        return document ? [document] : [];
      }),
    });
  const appended = cell.store.append(compiled),
    publication = cell.publicPublication(appended);
  cell.projection.apply(compiled.event, compiled.plan);
  return cell.lifecycleReceipt(
    compiled.event,
    cell.projection.read(taskId).snapshot,
    publication,
    cell.receiptProof(compiled.event, publication),
  );
}

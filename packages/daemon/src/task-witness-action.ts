import { createHash } from "node:crypto";
import { githubActionsWitnessEvidence, submittedGithubActionsRequirement } from "./repo-cell-ci-evidence.ts";
import {
  claimGateRun,
  compileGateRunChange,
  currentGateRun,
  settleGateRun,
  type CompletionEvidenceV1,
  type GateRun,
  type WriteReceiptDraft,
} from "@harness-anything/kernel";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoCellBinding, RepoTaskAction } from "./repo-cell-types.ts";
import { cellErrorCode } from "./repo-cell-errors.ts";

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
  if (!center && !(action.kind === "task-witness-revoke" || action.kind === "task-witness-rerun"))
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
    run = claimGateRun({
      execution,
      reuseCurrent: action.kind === "task-witness-claim",
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
    if (run.runId === prior?.runId)
      return (
        (requirement.witness.kind === "github-actions" ? settleGithubActionsClaim(cell, taskId, binding) : null) ?? {
          outcome: "no_changes",
          opId,
          revision: snapshot.revision,
          evidence: JSON.stringify({ run: prior }),
        }
      );
    operation = "claim";
  } else if (action.kind === "task-witness-settle") {
    if (action.evidence !== undefined) {
      const evidence = action.evidence as CompletionEvidenceV1;
      if (
        evidence.gateId !== gateId ||
        evidence.basis.executionId !== execution.executionId ||
        evidence.provenance.runId !== action.runId ||
        evidence.provenance.claimFence !== action.claimFence
      )
        throw cell.cellCodedError(
          "invalid_proof",
          "Settlement and evidence must identify the same gate run and fence.",
        );
      return cell.publishGateWitness(taskId, execution.executionId, snapshot, read.packagePath, binding, evidence);
    }
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
  const receipt = cell.lifecycleReceipt(
    compiled.event,
    cell.projection.read(taskId).snapshot,
    publication,
    cell.receiptProof(compiled.event, publication),
  );
  return operation === "claim" && requirement.witness.kind === "github-actions"
    ? (settleGithubActionsClaim(cell, taskId, binding) ?? receipt)
    : receipt;
}

/** Runs within the caller's center writer turn, after any claim has been published. */
function settleGithubActionsClaim(
  cell: RepoCellOperationalContext,
  taskId: string,
  binding: RepoCellBinding,
): WriteReceiptDraft | null {
  const read = cell.projection.read(taskId),
    target = submittedGithubActionsRequirement(read.snapshot);
  if (!target || target.execution.schema !== "execution/v1") return null;
  const evidence = githubActionsWitnessEvidence(cell, target.requirement, target.execution);
  if (!evidence) return null;
  const run = currentGateRun(target.execution, target.requirement.gateId)!;
  return cell.publishGateWitness(
    taskId,
    target.execution.executionId,
    read.snapshot,
    read.packagePath,
    { ...binding, actor: run.actor },
    evidence,
  );
}

/** CI imports already hold the center writer; reconcile their durable submitted demands there. */
export function settleImportedGithubActionsClaims(cell: RepoCellOperationalContext, binding: RepoCellBinding): void {
  for (const status of ["submitted", "in_review"] as const) {
    for (const { taskId, snapshot } of cell.projection.list({ status }).rows) {
      const target = submittedGithubActionsRequirement(snapshot);
      if (!target || target.execution.schema !== "execution/v1") continue;
      const current = currentGateRun(target.execution, target.requirement.gateId),
        latest = githubActionsWitnessEvidence(cell, target.requirement, target.execution, true);
      // A completed source run is terminal for its provider attempt, but a later settled
      // attempt of the same GitHub run is a new source result. Advance the source claim once
      // so the normal witness publication path can bind the latest verdict.
      try {
        if (
          current &&
          current.state === "completed" &&
          latest &&
          latest.diagnostic !== current.diagnostic &&
          target.requirement.witness.kind === "github-actions"
        ) {
          runTaskWitnessAction(
            cell,
            {
              kind: "task-witness-rerun",
              taskId,
              executionId: target.execution.executionId,
              gateId: target.requirement.gateId,
              runId: current.runId,
              reason: latest.diagnostic,
              [centerWitnessAction]: true,
            },
            {
              ...binding,
              actor: {
                principal: snapshot.task!.createdBy.principal,
                executor: { kind: "agent", id: `completion-source:${target.requirement.witness.adapterId}` },
              },
            },
          );
          continue;
        }
        runTaskWitnessAction(
          cell,
          {
            kind: "task-witness-claim",
            taskId,
            executionId: target.execution.executionId,
            gateId: target.requirement.gateId,
            [centerWitnessAction]: true,
          },
          {
            ...binding,
            actor: {
              principal: snapshot.task!.createdBy.principal,
              executor: { kind: "agent", id: `completion-source:${target.requirement.witness.adapterId}` },
            },
          },
        );
      } catch (error) {
        if (cellErrorCode(error) === "gate_run_stale") continue;
        throw error;
      }
    }
  }
}

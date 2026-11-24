import { createHash } from "node:crypto";
import {
  compileCompletionGateWitness,
  judgeCompletionEvidence,
  type CompletionEvidenceJudgment,
  isTaskEvent,
  type EventPublicationKillpoint,
  type TaskProjectionQueries,
  type CompletionEvidenceV1,
  type ActorIdentity,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import { taskShowFromProjection as readApplicationTaskShow } from "@harness-anything/application/internal/queries/task-show-read.ts";
import type { NodeTaskMaterializationPolicy } from "@harness-anything/kernel/internal/domain/task-wip-policy.ts";
import { readEffectiveCloseoutGates } from "./repo-cell-settings-state.ts";
import type { RepoCellActionContext, RepoCellBinding, Snapshot } from "./repo-cell-types.ts";
import { failed } from "./repo-cell-settlement.ts";
import { daemonTaskCoreQueryPorts } from "./task-core-query-ports.ts";
import { witnessOperationId } from "./repo-cell-proof.ts";

/**
 * The canonical witness write entry: judge the evidence's binding to the frozen cut, then let
 * `compileCompletionGateWitness` enforce that the evidence's source adapter equals the adapter
 * declared in the submission's frozen completion contract.
 */
export function publishGateWitness(
  cell: RepoCellActionContext,
  taskId: string,
  executionId: string,
  snapshot: Snapshot,
  packagePath: string | null,
  binding: RepoCellBinding,
  evidence: CompletionEvidenceV1,
): WriteReceipt {
  const execution = snapshot.executions.find(
    (value) => value.executionId === executionId && value.iteration === snapshot.task?.iteration,
  );
  if (!execution?.submission)
    throw cell.cellCodedError("invalid_transition", "A gate witness requires a submitted execution.");
  const judgment: CompletionEvidenceJudgment = judgeCompletionEvidence(evidence, {
    execution,
    gateId: evidence.gateId,
    admitFail: true,
  });
  if (!judgment.accepted)
    throw cell.cellCodedError(
      "invalid_proof",
      `Witness for gate ${evidence.gateId} cannot bind this cut: ${judgment.reason ?? "evidence was rejected"}.`,
    );
  const intent = {
      kind: "canonical-checker-receipt",
      taskId,
      executionId,
      gateId: evidence.gateId,
      result: evidence.result,
      runId: evidence.provenance.runId,
      claimFence: evidence.provenance.claimFence,
      basis: evidence.basis,
    },
    // A witness identifies its frozen cut and actor, independent of later writes or ingress node.
    opId = witnessOperationId(intent, binding.actor, cell.input.repoId),
    existing = cell.store.readEvent(opId);
  if (existing) {
    if (!isTaskEvent(existing) || existing.type !== "completion_gate_verified")
      throw cell.cellCodedError("op_conflict", `opId ${opId} belongs to another event`);
    if (!cell.projection.readOperation(opId)) cell.projection.apply(existing);
    const publication = cell.publicPublication(cell.store.publication(existing));
    return cell.lifecycleReceipt(
      existing,
      cell.projection.read(taskId).snapshot,
      publication,
      cell.receiptProof(existing, publication),
    );
  }
  const rawPaths = packagePath ? [`${packagePath}/INDEX.md`, `${packagePath}/executions/${executionId}.md`] : [],
    compiled = compileCompletionGateWitness({
      snapshot,
      taskId,
      executionId,
      gateId: evidence.gateId,
      result: evidence.result as "pass" | "fail",
      receiptId: opId,
      checkerId: evidence.checkerId,
      commitSha: execution.submission.commitSha,
      iteration: execution.iteration,
      reviewGate: readEffectiveCloseoutGates(cell.projection, snapshot).review,
      actor: binding.actor,
      source: binding.source,
      opId,
      eventId: `event-${createHash("sha256").update(opId).digest("hex")}`,
      workspaceRevision: (cell.store.readHead()?.revision ?? 0) + 1,
      occurredAt: cell.now(),
      evidence,
      packagePath,
      currentDocuments: rawPaths.flatMap((target) => {
        const document = cell.projection.readDocument(target).document;
        return document ? [document] : [];
      }),
    });
  const appended = cell.store.append(compiled),
    publication = cell.publicPublication(appended);
  cell.projection.apply(compiled.event, compiled.plan);
  cell.completionKillpoint("after_store_commit", opId);
  const receipt = cell.lifecycleReceipt(
    compiled.event,
    cell.projection.read(taskId).snapshot,
    publication,
    cell.receiptProof(compiled.event, publication),
  );
  cell.completionKillpoint("before_response_write", opId);
  cell.completionKillpoint("after_response_write", opId);
  return receipt;
}

export function completionKillpoint(cell: RepoCellActionContext, point: EventPublicationKillpoint, opId: string): void {
  try {
    cell.input.killpoint?.(point);
  } catch (cause) {
    const error = cell.cellCodedError(
      "publication_indeterminate",
      `publication result is unknown; run ha receipt show ${opId} before retrying`,
    ) as Error & {
      opId: string;
      cause?: unknown;
    };
    error.opId = opId;
    error.cause = cause;
    throw error;
  }
}

export function taskShowFromProjection(
  rootDir: string,
  projection: TaskProjectionQueries,
  taskId: string,
  directChildCount?: number,
  actor?: ActorIdentity,
  nodeTaskMaterializationPolicy: NodeTaskMaterializationPolicy = "include_done",
): WriteReceipt {
  return readApplicationTaskShow(rootDir, projection, taskId, directChildCount, actor, nodeTaskMaterializationPolicy, {
    ...daemonTaskCoreQueryPorts,
    failRead: failed,
  });
}

export { projectedTaskMaterializationState } from "@harness-anything/application/internal/queries/task-show-read.ts";

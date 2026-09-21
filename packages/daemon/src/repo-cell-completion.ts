import { readTaskCompletion } from "./task-completion-read.ts";
import { createHash } from "node:crypto";
import {
  completionGateIds,
  compileCompletionGateWitness,
  judgeCompletionEvidence,
  type CompletionEvidenceJudgment,
  deriveTaskRoot,
  hasCloseoutEvidence,
  isTaskEvent,
  type EventPublicationKillpoint,
  type TaskProjectionQueries,
  type CompletionEvidenceV1,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import type { RepoCellBinding, Snapshot } from "./repo-cell-types.ts";
import { resolveTaskRootThreshold } from "./task-wip-settings.ts";
import { readEffectiveReviewReturnBudget } from "./repo-cell-settings-state.ts";
import type { RepoCellActionContext } from "./repo-cell-action-context.ts";
import { renderEvidencePayload } from "./repo-cell-evidence.ts";
import { failed } from "./repo-cell-settlement.ts";
import { projectedTaskNotFound } from "./projection-readiness.ts";

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
      commitSha: execution.submission.commitSha,
      iteration: execution.iteration,
    },
    opId = cell.operationId(intent, binding, cell.input.repoId, snapshot.revision),
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
  cell.completionKillpoint("after_sqlite_commit", opId);
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

export async function showTask(cell: RepoCellActionContext, taskId: string): Promise<WriteReceipt> {
  await cell.service.read(cell.requiredCellText(taskId, "taskId"));
  return taskShowFromProjection(cell.rootDir, cell.projection, taskId);
}

export function taskShowFromProjection(
  rootDir: string,
  projection: TaskProjectionQueries,
  taskId: string,
  directChildCount = projection.readTaskChildCounts([taskId])[taskId] ?? 0,
): WriteReceipt {
  const read = projection.read(taskId),
    progress = projection.readProgress(taskId),
    rootSetting = resolveTaskRootThreshold(rootDir),
    notFound = projectedTaskNotFound(read, taskId);
  // task-show answers with receipts on every path — the fleet lease probe reads outcome/code
  // off the receipt — so settle the shared judgment instead of throwing past the attached
  // fast path, which has no write-queue settlement.
  if (notFound !== null) return failed(`read:${taskId}`, notFound);
  const task = read.snapshot.task,
    execution = read.snapshot.executions.find(
      (candidate) => candidate.iteration === task?.iteration && candidate.submission !== null,
    ),
    returnBudget = readEffectiveReviewReturnBudget(projection, task),
    rootAssessment = task
      ? deriveTaskRoot(
          {
            taskId,
            title: task.title,
            status: task.status,
            taskClass: task.taskClass,
            packageDisposition: task.packageDisposition ?? "active",
            hasOwnExecution:
              read.snapshot.lease !== null ||
              read.snapshot.executions.some(
                (execution) => execution.state === "active" || execution.state === "submitted",
              ),
            hasCloseoutEvidence: hasCloseoutEvidence(read.snapshot.executions),
            directChildCount,
          },
          rootSetting.threshold,
        )
      : null,
    completion = readTaskCompletion(projection, taskId),
    payload = {
      ...read.snapshot,
      task: task
        ? {
            ...task,
            completionGateIds: completionGateIds(task.completionGateIds, execution?.submission),
          }
        : null,
      packagePath: read.packagePath,
      returnBudget: returnBudget.value,
      returnBudgetSource: returnBudget.source,
      rootAssessment,
      completionNext: completion.completionNext,
      completionBlocker: completion.completionBlocker,
      progress: progress.rows,
    },
    receipt = {
      opId: `read:${taskId}`,
      revision: read.sourceRevision,
      evidence: JSON.stringify(payload),
      summary: renderEvidencePayload(payload),
      visibility: "center" as const,
      proof: {
        committedRevision: read.sourceRevision,
        appliedCut: Math.min(read.watermark, progress.watermark),
        durable: true,
        canonicalVisible: read.status === "ready" && progress.status === "ready",
        worktreeVisible: null,
      },
    };
  return read.status === "ready"
    ? { outcome: "applied", ...receipt }
    : {
        outcome: "pending",
        ...receipt,
      };
}

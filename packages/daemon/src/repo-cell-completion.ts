import { createHash } from "node:crypto";
import {
  compileCompletionGateWitness,
  deriveTaskRoot,
  hasCloseoutEvidence,
  isTaskEvent,
  type EventPublicationKillpoint,
  type WriteReceipt,
} from "../../kernel/src/index.ts";
import type { RepoCellBinding, Snapshot } from "./repo-cell-types.ts";
import { resolveTaskRootThreshold } from "./task-wip-settings.ts";

export function publishCiWitness(
  cell: any,
  taskId: string,
  executionId: string,
  snapshot: Snapshot,
  packagePath: string | null,
  binding: RepoCellBinding,
): WriteReceipt {
  const execution = snapshot.executions.find(
    (value) => value.executionId === executionId && value.iteration === snapshot.task?.iteration,
  );
  if (!execution?.submission)
    throw cell.cellCodedError("invalid_transition", "CI witness requires a submitted execution.");
  const intent = {
      kind: "canonical-checker-receipt",
      taskId,
      executionId,
      gateId: "ci",
      result: "pass",
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
      gateId: "ci",
      result: "pass",
      receiptId: opId,
      checkerId: "standard",
      commitSha: execution.submission.commitSha,
      iteration: execution.iteration,
      actor: binding.actor,
      source: binding.source,
      opId,
      eventId: `event-${createHash("sha256").update(opId).digest("hex")}`,
      workspaceRevision: (cell.store.readHead()?.revision ?? 0) + 1,
      occurredAt: cell.now(),
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

export function completionKillpoint(cell: any, point: EventPublicationKillpoint, opId: string): void {
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

export async function showTask(cell: any, taskId: string): Promise<WriteReceipt> {
  const read = await cell.service.read(cell.requiredCellText(taskId, "taskId")),
    projected = cell.projection.read(taskId),
    progress = cell.projection.readProgress(taskId),
    rootSetting = resolveTaskRootThreshold(cell.rootDir),
    directChildCount = cell.directChildCounts().get(taskId) ?? 0,
    task = read.snapshot.task,
    rootAssessment = task
      ? deriveTaskRoot(
          {
            taskId,
            title: task.title,
            status: task.status,
            taskClass: task.taskClass,
            packageDisposition: task.packageDisposition ?? "active",
            hasCloseoutEvidence: hasCloseoutEvidence(read.snapshot.executions),
            directChildCount,
          },
          rootSetting.threshold,
        )
      : null,
    receipt = {
      opId: `read:${taskId}`,
      revision: read.sourceRevision,
      evidence: JSON.stringify({
        ...read.snapshot,
        packagePath: projected.packagePath,
        rootAssessment,
        progress: progress.rows,
      }),
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
        nextAction: "Retry task show after projection catch-up.",
      };
}

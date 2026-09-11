import type { TaskLifecycleSnapshot } from "./task-lifecycle.contract.ts";
import { closeoutReadiness, currentExecutionCuts } from "./closeout-readiness.ts";
import { approvedReviewHistoryForExecution } from "./review.ts";
import type { TransitionDocumentMissingSection } from "./transition-document-readiness.ts";

export type CompletionBlockerCode =
  | "projection_unknown"
  | "execution_ambiguous"
  | "actor_unauthorized"
  | "document_invalid"
  | "not_in_review"
  | "task_blocked"
  | "executor_missing"
  | "closeout_placeholder"
  | "review_missing"
  | "consent_missing"
  | "ci_missing"
  | "code_doc_missing"
  | "decision_lineage_missing"
  | "lease_held"
  | "doc_sync_required"
  | "gate_witness_missing"
  | "fact_missing"
  | "fact_retirement_undeclared";
export interface CompletionNext {
  readonly reason: string;
  readonly action: string;
  readonly authority: string;
  readonly readCut: {
    readonly revision: number;
    readonly iteration: number | null;
    readonly executionId: string | null;
  };
}
export interface CompletionBlocker {
  readonly code: CompletionBlockerCode;
  readonly gate: string;
  readonly next: CompletionNext;
}
export interface CompletionReadinessContext {
  readonly closeout: "ready" | "placeholder" | "dirty_eligible" | "missing";
  readonly closeoutPath: string;
  readonly closeoutMissingSections?: readonly TransitionDocumentMissingSection[];
  readonly eligibleDirtyPaths: readonly string[];
  readonly producesFactCount: number;
  readonly projectionStatus?: "ready" | "pending";
  readonly preparedGateIds?: readonly string[];
  readonly authorization?: "allowed" | "denied";
  readonly invalidDocument?: { readonly path: string; readonly reason: string };
}

export function completionBlockers(
  snapshot: TaskLifecycleSnapshot,
  executionId: string,
  context: CompletionReadinessContext,
): readonly CompletionBlocker[] {
  const task = snapshot.task,
    execution = snapshot.executions.find(
      (value) => value.executionId === executionId && value.iteration === task?.iteration,
    ),
    one = (code: CompletionBlockerCode, gate: string, action: string, reason: string) =>
      [
        {
          code,
          gate,
          next: {
            ...completionGuidance(snapshot, executionId, action, reason),
            ...(gate === "review" ? { authority: "independent reviewer" } : {}),
            ...(gate === "consent" ? { authority: task?.createdBy.principal.personId ?? "task owner" } : {}),
          },
        },
      ] as const;
  if (context.projectionStatus === "pending" || !task)
    return one(
      "projection_unknown",
      "projection",
      "ha projection rebuild",
      "Rebuild the unavailable canonical task projection before retrying completion.",
    );
  if (context.authorization === "denied")
    return one(
      "actor_unauthorized",
      "authority",
      `ha task complete ${task.taskId}`,
      `Ask task owner ${task.createdBy.principal.personId} to run completion with the required authority.`,
    );
  if (context.invalidDocument)
    return one(
      "document_invalid",
      "documents",
      `Repair harness/${context.invalidDocument.path}.`,
      context.invalidDocument.reason,
    );
  const cuts = currentExecutionCuts(snapshot),
    candidates = cuts.length
      ? cuts
      : snapshot.executions.filter((value) => value.iteration === task.iteration && value.state === "active");
  if (candidates.length > 1)
    return one(
      "execution_ambiguous",
      "execution",
      `ha task show ${task.taskId}`,
      `Owner must resolve current execution candidates: ${candidates.map((cut) => cut.executionId).join(", ")}.`,
    );
  if (task.status === "done") return [];
  if (task.status === "blocked" || task.status === "cancelled")
    return one(
      "task_blocked",
      "lifecycle",
      `ha task show ${task.taskId}`,
      `Owner must resolve the ${task.status} task before completion.`,
    );
  if (!task || task.currentNode !== "review" || execution?.state !== "submitted" || !execution.submission)
    return one(
      "not_in_review",
      "lifecycle",
      task.status === "active"
        ? `Fill harness/${context.closeoutPath} with the verified delivery, then submit execution ${executionId}.`
        : `ha task start ${task.taskId}`,
      snapshot.lease
        ? `Execution is held by ${snapshot.lease.actor.executor?.id ?? snapshot.lease.actor.principal.personId}.`
        : "The current execution has not been submitted.",
    );
  if (task.status === "active" && execution.actor.executor === null)
    return one(
      "executor_missing",
      "lifecycle",
      [
        `ha task declare-executor ${task.taskId}`,
        `--execution-id ${executionId}`,
        "--reason <auditable-recovery-reason>",
      ].join(" "),
      "The submitted execution is already at review; restore its omitted executor instead of restarting it.",
    );
  if (task.status !== "in_review")
    return one(
      "not_in_review",
      "lifecycle",
      `ha task show ${task.taskId}`,
      "The Task status does not match its review node; inspect the lifecycle record before completion.",
    );
  if (snapshot.lease !== null)
    return one(
      "lease_held",
      "lease",
      `ha task release ${task.taskId}`,
      "The held execution lease must be released by its current holder.",
    );
  const assessment = closeoutReadiness(snapshot);
  const approved = approvedReviewHistoryForExecution(snapshot.reviews, execution);
  if (assessment.blocker === "review")
    return one(
      "review_missing",
      "review",
      `ha task review-execution ${task.taskId} --execution-id ${executionId} --review-id <id> --from-file <review.json>`,
      "Record one independent approved Execution Review.",
    );
  if (assessment.blocker === "consent") {
    if (approved.length !== 1)
      return one(
        "consent_missing",
        "consent",
        `ha task show ${task.taskId}`,
        `Owner must select one approved Review: ${approved.map((review) => review.reviewId).join(", ")}.`,
      );
    const reviewId = approved[0]!.reviewId;
    return one(
      "consent_missing",
      "consent",
      `ha task review-consent ${task.taskId} --execution-id ${executionId} ` +
        `--review-id ${reviewId} --consent-id consent-${reviewId}`,
      "Select one approved Review with content-pinned owner consent.",
    );
  }
  const gate = assessment.gates.find(
    ({ gateId, status }) => status !== "passed" && !context.preparedGateIds?.includes(gateId),
  );
  if (gate)
    return gate.gateId === "code-doc-reconciliation"
      ? one(
          "code_doc_missing",
          gate.gateId,
          execution.submission.deliverables.length
            ? `ha task code-doc reconcile ${task.taskId}` +
                execution.submission.deliverables.map((value) => ` --path '${value.replaceAll("'", "'\\''")}'`).join("")
            : `Identify the delivery paths in harness/${context.closeoutPath} Summary for execution ${executionId}.`,
          "The submitted execution cut has no canonical code/doc witness.",
        )
      : one(
          gate.gateId === "ci" ? "ci_missing" : "gate_witness_missing",
          gate.gateId,
          `ha task complete ${task.taskId} --execution-id ${executionId}`,
          `Publish a passing canonical ${gate.gateId} checker witness for this execution cut.`,
        );
  if (assessment.blocker === "lineage")
    return one(
      "decision_lineage_missing",
      "lineage",
      `Identify the authorizing Decision claim in harness/${context.closeoutPath} Summary.`,
      `A ${task.taskClass} task completes only with an active decision derives edge; no active edge names this task.`,
    );
  if (context.producesFactCount < 1)
    return one(
      "fact_missing",
      "facts",
      `ha fact record --task ${task.taskId} --statement <observation> --source <source>`,
      "A task requires at least one active task→fact produces edge before completion.",
    );
  if (context.closeout !== "ready" && context.closeout !== "dirty_eligible")
    return one(
      "closeout_placeholder",
      "closeout",
      `Fill harness/${context.closeoutPath} section ${context.closeoutMissingSections?.[0]?.section ?? "Summary"}.`,
      closeoutReason(context),
    );
  if (context.eligibleDirtyPaths.length)
    return one(
      "doc_sync_required",
      "documents",
      `ha doc sync --submit --task ${task.taskId}`,
      "Publish eligible closeout and artifact edits through doc-sync.",
    );
  return [];
}

function closeoutReason(context: CompletionReadinessContext): string {
  const first = context.closeoutMissingSections?.[0];
  return first
    ? `closeout.md section ${first.section} is ${first.reason}.`
    : "Replace the canonical closeout placeholder before completion.";
}

/** One read-only next decision for complete and task detail consumers. */
export function taskCompletionNext(
  snapshot: TaskLifecycleSnapshot,
  context: CompletionReadinessContext,
  requestedExecutionId?: string,
): {
  readonly executionId: string | null;
  readonly next: CompletionNext | null;
  readonly blocker: CompletionBlocker | null;
} {
  const cuts = currentExecutionCuts(snapshot),
    active = snapshot.executions.filter((value) => value.iteration === snapshot.task?.iteration),
    executionId =
      requestedExecutionId ??
      (cuts.length === 1 ? cuts[0]!.executionId : active.length === 1 ? active[0]!.executionId : null),
    blocker = completionBlockers(snapshot, executionId ?? "", context)[0] ?? null;
  return { executionId, next: blocker?.next ?? null, blocker };
}

export function completionGuidance(
  snapshot: TaskLifecycleSnapshot,
  executionId: string,
  action: string,
  reason: string,
): CompletionNext {
  return {
    reason,
    action,
    authority:
      snapshot.lease?.actor.executor?.id ??
      snapshot.lease?.actor.principal.personId ??
      snapshot.task?.createdBy.principal.personId ??
      "task owner",
    readCut: {
      revision: snapshot.revision,
      iteration: snapshot.task?.iteration ?? null,
      executionId: executionId || null,
    },
  };
}

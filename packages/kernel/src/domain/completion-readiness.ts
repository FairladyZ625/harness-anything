import type { TaskLifecycleSnapshot } from "./task-lifecycle.contract.ts";
import {
  closeoutReadiness,
  currentExecutionCuts,
  gateSatisfied,
  lineageOrphan,
  type CloseoutGateStatus,
} from "./closeout-readiness.ts";
import type { FrozenCompletionContract } from "./completion-contract.ts";
import type { MarkdownDocumentContract, TransitionDocumentMissingSection } from "./transition-document-readiness.ts";
import type { CloseoutGate } from "./settings-closeout.ts";
import { approvedReviewHistoryForExecution, reviewsForExecution, type ReviewV1 } from "./review.ts";
import type { ExecutionV1 } from "./execution.ts";

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
  /** `missing`: the task contract declares no closeout document (an older contract generation). */
  readonly closeout: "ready" | "placeholder" | "dirty_eligible" | "missing";
  readonly closeoutPath: string;
  readonly closeoutMissingSections?: readonly TransitionDocumentMissingSection[];
  readonly eligibleDirtyPaths: readonly string[];
  readonly producesFactCount: number;
  readonly projectionStatus?: "ready" | "pending";
  readonly preparedGateIds?: readonly string[];
  readonly authorization?: "allowed" | "denied";
  readonly invalidDocument?: { readonly path: string; readonly reason: string };
  readonly closeoutGates?: Readonly<Record<CloseoutGate, boolean>>;
  readonly closeoutContract?: MarkdownDocumentContract | null;
  /** Whether declare-executor has a dispatch record it can replay as executor proof. */
  readonly hasDispatchLineage?: boolean;
}

export function completionBlockers(
  snapshot: TaskLifecycleSnapshot,
  executionId: string,
  context: CompletionReadinessContext,
): readonly CompletionBlocker[] {
  return evaluateCompletion(snapshot, executionId, context, true);
}

/** Mechanical preparation uses the same checks; final completion always also checks Review and consent. */
export function completionPreparationBlockers(
  snapshot: TaskLifecycleSnapshot,
  executionId: string,
  context: CompletionReadinessContext,
): readonly CompletionBlocker[] {
  return evaluateCompletion(snapshot, executionId, context, false);
}

/** The remediation command for an unsatisfied gate follows its judged status and the frozen contract. */
function witnessCommand(
  taskId: string,
  gateId: string,
  status: CloseoutGateStatus,
  contract: FrozenCompletionContract | undefined,
  executionId: string,
): string {
  const requirement = contract?.gates.find((gate) => gate.gateId === gateId),
    adapterId = requirement?.witness.adapterId;
  if (requirement?.allowOverride && adapterId !== "manual-attest") {
    if (status === "failed")
      return (
        `ha task attest ${taskId} --gate ${gateId} --result pass --mode override ` +
        "--rationale <why-the-recorded-fail-is-waived>"
      );
    if (status === "missing")
      return (
        `ha task attest ${taskId} --gate ${gateId} --result pass --mode override ` +
        "--rationale <why-no-automated-witness-is-acceptable>"
      );
  }
  if (adapterId === "manual-attest" || status === "signoff_missing")
    return `ha task attest ${taskId} --gate ${gateId} --result pass`;
  if (adapterId === "local-command")
    return `ha task submit ${taskId} (the local-command witness runs against the submitted cut)`;
  if (adapterId === "github-actions" || gateId === "ci") return "ha ci observe pull";
  return `Run the canonical ${gateId} checker to witness execution ${executionId}.`;
}

function evaluateCompletion(
  snapshot: TaskLifecycleSnapshot,
  executionId: string,
  context: CompletionReadinessContext,
  includeReview: boolean,
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
            ...(gate === "consent" ? { authority: task?.createdBy.principal.personId ?? "task owner" } : {}),
          },
        },
      ] as const;
  if (context.projectionStatus === "pending" || !task)
    return one(
      "projection_unknown",
      "projection",
      "ha daemon projection rebuild",
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
  if (context.closeout === "missing")
    return one(
      "document_invalid",
      "closeout",
      `ha task contract migrate --apply --task ${task.taskId}`,
      "The task contract declares no closeout document; migrate the contract before continuing completion.",
    );
  if (task.status === "active" && execution?.state === "active" && snapshot.lease === null)
    return one(
      "not_in_review",
      "lifecycle",
      `ha task transition ${task.taskId} planned --reason <why-work-is-returning-to-planning>`,
      "The execution lease was released; return the unowned round to planning before starting again.",
    );
  if (!task || task.currentNode !== "review" || execution?.state !== "submitted" || !execution.submission)
    return one(
      "not_in_review",
      "lifecycle",
      task.status === "active" && execution ? `ha task submit ${task.taskId}` : `ha task start ${task.taskId}`,
      snapshot.lease
        ? `Fill harness/${context.closeoutPath} with the verified delivery before submitting execution ${executionId}; ` +
            `the execution is held by ${snapshot.lease.actor.executor?.id ?? snapshot.lease.actor.principal.personId}.`
        : "The current execution has not been submitted.",
    );
  // The executor only matters for judging reviewer independence, so it is restored only while an
  // independent review is still owed: the review gate applies and nobody has reviewed this cut yet
  // (a recorded review already judged independence; an adverse one routes to the owner's return).
  if (
    task.status === "in_review" &&
    execution.actor.executor === null &&
    context.closeoutGates?.review !== false &&
    reviewsForExecution(snapshot.reviews, execution).length === 0
  )
    return one(
      "executor_missing",
      "lifecycle",
      context.hasDispatchLineage === false
        ? `ha task review-execution ${task.taskId} --execution-id ${executionId} --review-id <id> --from-file <review.json>`
        : [
            `ha task declare-executor ${task.taskId}`,
            `--execution-id ${executionId}`,
            "--reason <auditable-recovery-reason>",
          ].join(" "),
      context.hasDispatchLineage === false
        ? "This execution has no dispatch record to declare; an independent reviewer must record the review."
        : "The submitted execution is already at review; restore its omitted executor from its dispatch record.",
    );
  if (task.status === "submitted" && context.closeoutGates?.review !== false)
    return one(
      "not_in_review",
      "lifecycle",
      `ha task adjudicate ${task.taskId} --forward --note-file <path>`,
      "The cut awaits the owning CEO's triage; completion is mechanical only after independent review " +
        "and the owner's verdict.",
    );
  // A lightweight cut (review gate lifted) completes straight off submitted; every other
  // status off the review corridor has no completion to run.
  if (!["submitted", "in_review"].includes(task.status))
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
  const closeoutGates = context.closeoutGates ?? {
      review: true,
      consent: true,
      fact: true,
      factDisposition: true,
      codeDoc: true,
    },
    assessment = closeoutReadiness(snapshot, undefined, closeoutGates);
  const gate = assessment.gates.find(
    ({ gateId, status }) =>
      !gateSatisfied(status) &&
      (gateId !== "code-doc-reconciliation" || closeoutGates.codeDoc) &&
      !context.preparedGateIds?.includes(gateId),
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
          witnessCommand(task.taskId, gate.gateId, gate.status, execution.submission.completionContract, executionId),
          gate.status === "signoff_missing"
            ? `Gate ${gate.gateId} passed its automated witness and requires a human signoff for this execution cut.`
            : `Publish a passing canonical ${gate.gateId} checker witness for this execution cut.`,
        );
  if (lineageOrphan(task, snapshot.decisionRelations ?? []))
    return one(
      "decision_lineage_missing",
      "lineage",
      `Identify the authorizing Decision claim in harness/${context.closeoutPath} Summary.`,
      `A ${task.taskClass} task completes only with an active decision derives edge; no active edge names this task.`,
    );
  // The Fact-production requirement is task-bound: a profile that declared `fact: false`
  // (lightweight) closes its loop with the closeout verification record instead.
  if (closeoutGates.fact !== false && context.producesFactCount < 1)
    return one(
      "fact_missing",
      "facts",
      `ha fact record --task ${task.taskId} --statement "<what changed and why it matters>" --source "<evidence path or observation>" --confidence high`,
      "Describe the system's observable change and cite its evidence in a Fact. " +
        "Keep execution recaps and test counts in closeout Verification; the Fact should explain what is now true.",
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
  if (!includeReview) return [];
  // The assessment already carries the gate judgment; re-deriving review or consent here
  // would duplicate the one closeout-readiness decision.
  if (assessment.blocker === "review") {
    const changes = changesRequestedReview(snapshot.reviews, execution);
    return changes
      ? one(
          "review_missing",
          "review",
          reviewReturnCommand(task.taskId, changes.reviewId),
          `Review ${changes.reviewId} requested changes; the owner returns the cut with rework instructions in the note.`,
        )
      : one(
          "review_missing",
          "review",
          `ha task dispatch-review ${task.taskId}`,
          "The forwarded cut has no recorded review; wait for the dispatched reviewer's verdict or dispatch one.",
        );
  }
  if (assessment.blocker === "consent")
    return one(
      "consent_missing",
      "consent",
      reviewConsentCommands(task.taskId, snapshot.reviews, execution).join(" or "),
      "The owner's verdict accepts the latest approved review, pinned to its reviewed content.",
    );
  return [];
}

/** The latest changes_requested verdict on the submitted cut: an adverse verdict the owner adjudicates. */
export function changesRequestedReview(reviews: readonly ReviewV1[], execution: ExecutionV1): ReviewV1 | undefined {
  return reviewsForExecution(reviews, execution)
    .filter((review) => review.verdict === "changes_requested")
    .at(-1);
}

export function reviewReturnCommand(taskId: string, reviewId: string): string {
  return `ha task adjudicate ${taskId} --return --review-id ${reviewId} --note-file <path>`;
}

/** review-consent selects a sole approved candidate itself; several candidates each need their explicit command. */
export function reviewConsentCommands(
  taskId: string,
  reviews: readonly ReviewV1[],
  execution: ExecutionV1,
): readonly string[] {
  const candidates = approvedReviewHistoryForExecution(reviews, execution);
  return candidates.length === 1
    ? [`ha task review-consent ${taskId}`]
    : candidates.map((review) => `ha task review-consent ${taskId} --review-id ${review.reviewId}`);
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

/** The command a caller can execute now, including complete itself once no blocker remains. */
export function taskCompletionAction(
  snapshot: TaskLifecycleSnapshot,
  context: CompletionReadinessContext,
  requestedExecutionId?: string,
): CompletionNext | null {
  const judged = taskCompletionNext(snapshot, context, requestedExecutionId);
  if (judged.next || snapshot.task?.status === "done") return judged.next;
  return completionGuidance(
    snapshot,
    judged.executionId ?? "",
    `ha task complete ${snapshot.task?.taskId ?? "<task-id>"}`,
    "The completion chain has no remaining blocker.",
  );
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

import { isNativeCommitSha } from "./execution.ts";
import { digest } from "./digest.ts";
import type { ExecutionV1 } from "./execution.ts";
import { reviewDigest } from "./review.ts";
import type { ReviewConsentV1, ReviewV1 } from "./review.ts";
import type { CodeDocWitnessV1 } from "./code-doc-witness.ts";
import type { ContractValidationIssue, TaskV1 } from "./task.ts";
import { isNonEmptyString } from "./write-chain.contract.ts";
import { stableStringify } from "../integrity/stable-hash.ts";
import type {
  CodeDocReconciledEvent,
  ReviewConsentRecordedEvent,
  ReviewRecordedEvent,
  TaskCompletedEvent,
} from "./task-lifecycle-event.ts";
import { isIndependentFrom, isSameExecution } from "./actor-domain-services.ts";
import { closeoutReadiness } from "./closeout-readiness.ts";
import type {
  CodeDocProof,
  CompleteTaskCommand,
  CompleteTaskProof,
  ReconcileCodeDocCommand,
  RecordReviewCommand,
  RecordReviewConsentCommand,
  ReviewConsentProof,
  ReviewProof,
  TaskLifecycleSnapshot,
  Transition,
} from "./task-lifecycle-contract-internal-types.ts";
import {
  canonicalDocumentPaths,
  canonicalGateReceipts,
  envelope,
  execution,
  lifecycleContractIssue,
  replaceExecution,
  revisionIssues,
  takeEdge,
} from "./task-lifecycle-contract-support.ts";

// Review, consent, code-document, and completion transition definitions.
function reviewIssues(
  snapshot: TaskLifecycleSnapshot,
  command: RecordReviewCommand,
  proof: Partial<ReviewProof>,
): ContractValidationIssue[] {
  const issues = revisionIssues(snapshot, command),
    current = execution(snapshot, command.executionId);
  if (
    snapshot.task?.status !== "in_review" ||
    snapshot.task.currentNode !== "review" ||
    current?.state !== "submitted" ||
    !current.submission
  )
    issues.push(lifecycleContractIssue("invalid_transition", "Review requires the current submitted execution"));
  else if (snapshot.reviews.some((value) => value.reviewId === command.reviewId))
    issues.push(lifecycleContractIssue("invalid_transition", "append-only Review history requires a new review id"));
  else if (
    command.commitSha !== current.submission.commitSha ||
    command.iteration !== current.iteration ||
    !isIndependentFrom(current.actor, command.actor)
  )
    issues.push(
      lifecycleContractIssue("invalid_proof", "Review must bind the current content cut and an independent reviewer"),
    );
  if (
    !proof.actorBinding ||
    !isSameExecution(command.actor, proof.actorBinding) ||
    proof.capability !== "execution-review@v1" ||
    !isNonEmptyString(proof.capabilityRef) ||
    !isNonEmptyString(command.reviewId) ||
    !isNonEmptyString(command.reason) ||
    !Array.isArray(command.evidenceChecked) ||
    !digest(command.contentDigest)
  )
    issues.push(
      lifecycleContractIssue("invalid_proof", "transport-bound execution review proof and content digest are required"),
    );
  if (
    command.verdict === "changes_requested" &&
    (snapshot.task?.iteration ?? 0) >= (snapshot.task?.graph.maxIterations ?? 0)
  )
    issues.push(
      lifecycleContractIssue(
        "manual_intervention_required",
        "return budget exhausted; escalate for manual intervention",
      ),
    );
  return issues;
}
function reviewFrom(command: RecordReviewCommand, proof: ReviewProof): ReviewV1 {
  return {
    schema: "review/v1",
    reviewId: command.reviewId,
    taskId: command.taskId,
    executionId: command.executionId,
    verdict: command.verdict,
    actor: command.actor,
    capabilityRef: proof.capabilityRef,
    reason: command.reason,
    evidenceChecked: command.evidenceChecked,
    commitSha: command.commitSha,
    iteration: command.iteration as 0 | 1,
    contentDigest: command.contentDigest,
    reviewedAt: command.occurredAt,
  };
}
export const review: Transition = {
  id: "record_execution_review",
  commandType: "RecordReview",
  from: "in_review/review",
  proof: ["independentActor", "execution-review@v1", "contentCut"],
  eventType: "review_recorded",
  matches: (command) => command.type === "RecordReview",
  validate: (snapshot, raw, proof) => reviewIssues(snapshot, raw as RecordReviewCommand, proof as Partial<ReviewProof>),
  reduce: (snapshot, raw, rawProof) => {
    const command = raw as RecordReviewCommand,
      current = execution(snapshot, command.executionId) as ExecutionV1,
      recorded = reviewFrom(command, rawProof as ReviewProof);
    if (command.verdict !== "changes_requested")
      return {
        snapshot: {
          ...snapshot,
          revision: command.workspaceRevision,
          reviews: [...snapshot.reviews, recorded],
        },
        event: envelope<ReviewRecordedEvent>(command, "review_recorded", {
          task: snapshot.task as TaskV1,
          execution: current,
          review: recorded,
        }),
      };
    const nextExecution: ExecutionV1 = {
        ...current,
        state: "changes_requested",
        closedAt: command.occurredAt,
      },
      task: TaskV1 = {
        ...(snapshot.task as TaskV1),
        status: "active",
        currentNode: "implementation",
        iteration: 1,
      },
      edge = takeEdge(
        snapshot.task as TaskV1,
        "changes_requested",
        command.reason,
        command.commitSha,
        command.iteration,
      );
    return {
      snapshot: {
        ...snapshot,
        revision: command.workspaceRevision,
        task,
        executions: replaceExecution(snapshot.executions, nextExecution),
        reviews: [...snapshot.reviews, recorded],
        edgesTaken: [...snapshot.edgesTaken, edge],
        lease: null,
      },
      event: envelope<ReviewRecordedEvent>(command, "review_recorded", {
        task,
        execution: nextExecution,
        review: recorded,
        edge,
      }),
    };
  },
};
export const consent: Transition = {
  id: "record_review_consent",
  commandType: "RecordReviewConsent",
  from: "in_review/review/approved",
  proof: ["ownerActor", "execution-consent@v1", "reviewDigest", "contentDigest"],
  eventType: "review_consent_recorded",
  matches: (command) => command.type === "RecordReviewConsent",
  validate: (snapshot, raw, rawProof) => {
    const command = raw as RecordReviewConsentCommand,
      proof = rawProof as Partial<ReviewConsentProof>,
      issues = revisionIssues(snapshot, command),
      current = execution(snapshot, command.executionId),
      recorded = snapshot.reviews.find(
        (value) => value.reviewId === command.reviewId && value.executionId === command.executionId,
      );
    if (
      snapshot.task?.status !== "in_review" ||
      current?.state !== "submitted" ||
      recorded?.verdict !== "approved" ||
      snapshot.consents.some((value) => value.reviewId === command.reviewId)
    )
      issues.push(
        lifecycleContractIssue("invalid_transition", "consent must select an unconsented approved current Review"),
      );
    if (
      !recorded ||
      command.reviewDigest !== reviewDigest(recorded) ||
      command.contentDigest !== recorded.contentDigest ||
      !proof.actorBinding ||
      !isSameExecution(command.actor, proof.actorBinding) ||
      !snapshot.task ||
      !isSameExecution(command.actor, snapshot.task.createdBy) ||
      proof.capability !== "execution-consent@v1" ||
      !isNonEmptyString(proof.capabilityRef) ||
      !isNonEmptyString(command.consentId)
    )
      issues.push(
        lifecycleContractIssue("invalid_proof", "owner consent must bind the Review and reviewed content digests"),
      );
    return issues;
  },
  reduce: (snapshot, raw) => {
    const command = raw as RecordReviewConsentCommand,
      current = execution(snapshot, command.executionId) as ExecutionV1,
      recorded = snapshot.reviews.find((value) => value.reviewId === command.reviewId) as ReviewV1,
      value: ReviewConsentV1 = {
        schema: "review-consent/v1",
        consentId: command.consentId,
        taskId: command.taskId,
        executionId: command.executionId,
        reviewId: command.reviewId,
        reviewDigest: command.reviewDigest,
        contentDigest: command.contentDigest,
        actor: command.actor,
        source: command.source,
        consentedAt: command.occurredAt,
      };
    return {
      snapshot: {
        ...snapshot,
        revision: command.workspaceRevision,
        consents: [...snapshot.consents, value],
      },
      event: envelope<ReviewConsentRecordedEvent>(command, "review_consent_recorded", {
        task: snapshot.task as TaskV1,
        execution: current,
        review: recorded,
        consent: value,
      }),
    };
  },
};
export const reconcile: Transition = {
  id: "reconcile_code_doc",
  commandType: "ReconcileCodeDoc",
  from: "in_review/review",
  proof: ["actorBinding", "code-doc-reconcile@v1", "commitPaths"],
  eventType: "code_doc_reconciled",
  matches: (command) => command.type === "ReconcileCodeDoc",
  validate: (snapshot, raw, rawProof) => {
    const command = raw as ReconcileCodeDocCommand,
      proof = rawProof as Partial<CodeDocProof>,
      issues = revisionIssues(snapshot, command),
      current = execution(snapshot, command.executionId);
    if (snapshot.task?.status !== "in_review" || current?.state !== "submitted" || !current.submission)
      issues.push(
        lifecycleContractIssue("invalid_transition", "code-doc reconcile requires the current submitted execution"),
      );
    if (
      !current?.submission ||
      command.commitSha !== current.submission.commitSha ||
      command.iteration !== current.iteration ||
      !isNativeCommitSha(command.commitSha) ||
      !isNonEmptyString(command.witnessId) ||
      !canonicalDocumentPaths(command.paths) ||
      !proof.actorBinding ||
      !isSameExecution(command.actor, proof.actorBinding) ||
      proof.capability !== "code-doc-reconcile@v1" ||
      !isNonEmptyString(proof.capabilityRef)
    )
      issues.push(
        lifecycleContractIssue("invalid_proof", "code-doc witness must bind canonical paths to the submitted commit"),
      );
    return issues;
  },
  reduce: (snapshot, raw) => {
    const command = raw as ReconcileCodeDocCommand,
      current = execution(snapshot, command.executionId) as ExecutionV1,
      witness: CodeDocWitnessV1 = {
        schema: "code-doc-witness/v1",
        witnessId: command.witnessId,
        taskId: command.taskId,
        executionId: command.executionId,
        commitSha: command.commitSha,
        iteration: command.iteration as 0 | 1,
        paths: [...new Set(command.paths)].sort(),
        actor: command.actor,
        source: command.source,
        reconciledAt: command.occurredAt,
      },
      witnesses = [...snapshot.codeDocWitnesses.filter((value) => value.executionId !== command.executionId), witness];
    return {
      snapshot: {
        ...snapshot,
        revision: command.workspaceRevision,
        codeDocWitnesses: witnesses,
      },
      event: envelope<CodeDocReconciledEvent>(command, "code_doc_reconciled", {
        task: snapshot.task as TaskV1,
        execution: current,
        witness,
      }),
    };
  },
};
export function isReadyToComplete(snapshot: TaskLifecycleSnapshot): boolean {
  return closeoutReadiness(snapshot).readiness === "ready";
}
export const complete: Transition = {
  id: "complete_task",
  commandType: "CompleteTask",
  from: "in_review/review/ready",
  proof: ["ownerOrCommander", "reviewConsent", "typedGateReceipts", "noActiveLease"],
  eventType: "task_completed",
  matches: (command) => command.type === "CompleteTask",
  validate: (snapshot, raw, rawProof) => {
    const command = raw as CompleteTaskCommand,
      proof = rawProof as Partial<CompleteTaskProof>,
      issues = revisionIssues(snapshot, command),
      task = snapshot.task,
      current = execution(snapshot, command.executionId),
      assessment = closeoutReadiness(snapshot);
    if (
      task?.status !== "in_review" ||
      task.currentNode !== "review" ||
      current?.state !== "submitted" ||
      assessment.readiness !== "ready"
    )
      issues.push(
        lifecycleContractIssue(
          "invalid_transition",
          assessment.blocker === "lineage" && task
            ? `CompleteTask for a ${task.taskClass} task requires an active decision derives edge; ` +
                "run ha decision relate <decision-id> --anchor <claim-id> --type derives " +
                `--target task/${task.taskId} --rationale <why this decision authorises the task>`
            : "CompleteTask requires a consent-selected approved Review",
        ),
      );
    if (
      snapshot.lease ||
      proof.noActiveLease !== true ||
      proof.capability !== "task-complete@v1" ||
      !isNonEmptyString(proof.capabilityRef) ||
      !["owner", "commander"].includes(String(proof.actorRole))
    )
      issues.push(lifecycleContractIssue("invalid_proof", "completion authority and released lease are required"));
    if (task && current) {
      const receipts = [...(proof.gateReceipts ?? [])].sort((left, right) => left.gateId.localeCompare(right.gateId)),
        canonical = [...canonicalGateReceipts(snapshot, current)].sort((left, right) =>
          left.gateId.localeCompare(right.gateId),
        );
      if (stableStringify(canonical) !== stableStringify(receipts))
        issues.push(
          lifecycleContractIssue(
            "invalid_proof",
            "CompleteTask may reference only L2-verified gate witnesses for this execution cut",
          ),
        );
    }
    return issues;
  },
  reduce: (snapshot, raw) => {
    const command = raw as CompleteTaskCommand,
      current = execution(snapshot, command.executionId) as ExecutionV1,
      nextExecution: ExecutionV1 = {
        ...current,
        state: "accepted",
        closedAt: command.occurredAt,
      },
      task: TaskV1 = {
        ...(snapshot.task as TaskV1),
        status: "done",
        pinned: false,
      };
    return {
      snapshot: {
        ...snapshot,
        revision: command.workspaceRevision,
        task,
        executions: replaceExecution(snapshot.executions, nextExecution),
      },
      event: envelope<TaskCompletedEvent>(command, "task_completed", {
        task,
        execution: nextExecution,
      }),
    };
  },
};

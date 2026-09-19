import { isNonEmptyString } from "./write-chain.contract.ts";
import type { ExecutionV1 } from "./execution.ts";
import type { TaskV2 } from "./task.ts";
import { isSameExecution, isSamePerson } from "./actor-domain-services.ts";
import type { SubmissionForwardedEvent, SubmissionReturnedEvent } from "./task-lifecycle-event.ts";
import type {
  AdjudicateSubmissionCommand,
  AdjudicationProof,
  Transition,
} from "./task-lifecycle-contract-internal-types.ts";
import {
  envelope,
  execution,
  lifecycleContractIssue,
  replaceExecution,
  revisionIssues,
} from "./task-lifecycle-contract-support.ts";

// The owner's adjudication transitions (owner ruling 2026-09-19): the double CEO gate between
// the worker's submitted cut and the review phase. The reviewer records verdicts but commands
// nothing; only the task-owning principal may forward a cut to the review gate or return it
// with a rework note. One command family, two decisions, two events.
export const adjudicate: Transition = {
  actionId: "adjudicate",
  matches: (command) => command.type === "AdjudicateSubmission",
  validate: (snapshot, raw, rawProof) => {
    const command = raw as AdjudicateSubmissionCommand,
      proof = rawProof as Partial<AdjudicationProof>,
      issues = revisionIssues(snapshot, command),
      task = snapshot.task,
      current = execution(snapshot, command.executionId);
    if (command.decision === "forward") {
      if (
        task?.status !== "submitted" ||
        task.currentNode !== "review" ||
        current?.state !== "submitted" ||
        !current.submission
      )
        issues.push(
          lifecycleContractIssue(
            "invalid_transition",
            "forwarding requires the current submitted cut awaiting the owner's triage (status submitted)",
          ),
        );
    } else if (command.decision === "return") {
      if (
        !task ||
        !["submitted", "in_review"].includes(task.status) ||
        task.currentNode !== "review" ||
        current?.state !== "submitted" ||
        !current.submission
      )
        issues.push(
          lifecycleContractIssue(
            "invalid_transition",
            "a return order requires the current submitted cut at the review gate (status submitted or in_review)",
          ),
        );
      else if (
        command.reviewId !== undefined &&
        !snapshot.reviews.some(
          (value) => value.reviewId === command.reviewId && value.executionId === command.executionId,
        )
      )
        issues.push(
          lifecycleContractIssue("invalid_proof", "a verdict return must name a recorded review of this cut"),
        );
    } else {
      issues.push(lifecycleContractIssue("invalid_schema", "adjudication decides forward or return"));
    }
    if (snapshot.lease !== null)
      issues.push(lifecycleContractIssue("invalid_transition", "adjudication requires the released post-submit state"));
    if (!isNonEmptyString(command.reason))
      issues.push(lifecycleContractIssue("missing_field", "adjudication requires the owner's auditable note"));
    if (
      !proof.actorBinding ||
      !isSameExecution(command.actor, proof.actorBinding) ||
      proof.capability !== "task-adjudicate@v1" ||
      !isNonEmptyString(proof.capabilityRef) ||
      !task ||
      !isSamePerson(task.createdBy, command.actor)
    )
      issues.push(
        lifecycleContractIssue("invalid_proof", "only the task-owning principal may adjudicate the submitted cut"),
      );
    return issues;
  },
  reduce: (snapshot, raw) => {
    const command = raw as AdjudicateSubmissionCommand,
      current = execution(snapshot, command.executionId) as ExecutionV1;
    if (command.decision === "forward") {
      const task: TaskV2 = { ...(snapshot.task as TaskV2), status: "in_review" as const };
      return {
        snapshot: { ...snapshot, revision: command.workspaceRevision, task },
        event: envelope<SubmissionForwardedEvent>(command, "submission_forwarded", {
          task,
          execution: current,
          reason: command.reason,
        }),
      };
    }
    const nextExecution: ExecutionV1 = {
        ...current,
        state: "changes_requested",
        closedAt: command.occurredAt,
      },
      task: TaskV2 = {
        ...(snapshot.task as TaskV2),
        status: "active",
        currentNode: "implementation",
        iteration: (snapshot.task?.iteration ?? 0) + 1,
      };
    return {
      snapshot: {
        ...snapshot,
        revision: command.workspaceRevision,
        task,
        executions: replaceExecution(snapshot.executions, nextExecution),
        lease: null,
      },
      event: envelope<SubmissionReturnedEvent>(command, "submission_returned", {
        task,
        execution: nextExecution,
        reason: command.reason,
        ...(command.reviewId !== undefined ? { reviewId: command.reviewId } : {}),
      }),
    };
  },
};

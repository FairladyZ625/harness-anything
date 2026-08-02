import { Schema } from "effect";
import {
  executionDeclaration,
  sha256Text,
  type ExecutionRecord,
  type TaskHolderPrincipal,
  type TaskHolderSnapshot
} from "@harness-anything/kernel";
import {
  decodeTaskCompleteTransitionCommand
} from "./authority/task-complete-transition-command.ts";
import type { TaskCompleteTransitionCommand } from "./authority/daemon-host-contract.ts";
import type { TaskCompletionEvidence } from "./task-completion-authority.ts";

export type TaskCurrentRoundManualCategory =
  | "multiple-open-rounds"
  | "multiple-accepted-history"
  | "no-current-round"
  | "selected-round-not-found";

export type TaskCurrentRound =
  | { readonly kind: "active"; readonly execution: ExecutionRecord }
  | { readonly kind: "submitted"; readonly execution: ExecutionRecord }
  | { readonly kind: "accepted-replay"; readonly execution: ExecutionRecord }
  | {
      readonly kind: "manual-disposition";
      readonly category: TaskCurrentRoundManualCategory;
      readonly candidateExecutionIds: ReadonlyArray<string>;
    };

export interface VerifiedTaskCompleteDocumentPublicationWitness {
  readonly kind: "document-publication";
  readonly ref: string;
  readonly repositoryCommit: string;
  readonly publicationOperationIds: ReadonlyArray<string>;
  readonly coveredTaskRelativePaths: ReadonlyArray<string>;
  readonly coveredPathSetDigest: string;
}

export interface VerifiedTaskCompleteCodeDocWitness {
  readonly kind: "code-doc-reconciliation";
  readonly ref: string;
  readonly repositoryCommit: string;
  readonly publicationOperationIds: ReadonlyArray<string>;
  readonly taskId: string;
  readonly reconciledCommitRef: string;
  readonly normalizedPaths: ReadonlyArray<string>;
  readonly prRef: string | null;
  readonly codeDocBodyDigest: string;
}

export type VerifiedTaskCompleteExternalWitness =
  | VerifiedTaskCompleteDocumentPublicationWitness
  | VerifiedTaskCompleteCodeDocWitness;

interface CanonicalTaskMutationPlanBase {
  readonly schema: "canonical-task-mutation-plan/v1";
  readonly transitionId: string;
  readonly callerIdempotencyKey: string;
  readonly taskId: string;
  readonly command: TaskCompleteTransitionCommand;
  readonly verifiedExternalWitnesses: ReadonlyArray<VerifiedTaskCompleteExternalWitness>;
  readonly completionContractBodySha256: string | null;
}

export type CanonicalTaskMutationPlan =
  | (CanonicalTaskMutationPlanBase & {
      readonly kind: "execution-review";
      readonly executionId: string;
      readonly reviewId: string;
      readonly consentId: string;
    })
  | (CanonicalTaskMutationPlanBase & {
      readonly kind: "accepted-replay";
      readonly executionId: string;
      readonly approvedReviewId: string;
      readonly consumedConsentId: string;
    })
  | (CanonicalTaskMutationPlanBase & {
      readonly kind: "commit-anchor";
      readonly evidence: TaskCompletionEvidence;
    })
  | (CanonicalTaskMutationPlanBase & {
      readonly kind: "already-committed";
      readonly committedCase: "execution-review" | "accepted-replay" | "commit-anchor";
      readonly executionId: string | null;
    });

export interface ExistingTaskLifecycleTransition {
  readonly transitionId: string;
  readonly callerIdempotencyKey: string;
  readonly taskId: string;
  readonly committedCase: "execution-review" | "accepted-replay" | "commit-anchor";
  readonly executionId: string | null;
  readonly terminalTaskStatus: "done";
  readonly terminalExecutionState: "accepted" | null;
}

export interface TaskLifecycleTransitionSnapshot {
  readonly taskId: string;
  readonly taskStatus: string;
  readonly currentRound: TaskCurrentRound;
  readonly holder: TaskHolderSnapshot;
  readonly sessionBinding: {
    readonly sessionId: string;
    readonly actor: TaskHolderPrincipal;
  };
  readonly verifiedExternalWitnesses: ReadonlyArray<VerifiedTaskCompleteExternalWitness>;
  readonly completionContractBodySha256: string | null;
  readonly existingTransition?: ExistingTaskLifecycleTransition;
  readonly acceptedReplayApproval?: {
    readonly reviewId: string;
    readonly consentId: string;
  };
  readonly commitEvidence?: TaskCompletionEvidence;
}

export class TaskLifecycleTransitionPlanningError extends Error {
  readonly code: string;
  readonly manualCategory?: TaskCurrentRoundManualCategory;

  constructor(code: string, message: string, manualCategory?: TaskCurrentRoundManualCategory) {
    super(message);
    this.name = "TaskLifecycleTransitionPlanningError";
    this.code = code;
    this.manualCategory = manualCategory;
  }
}

export const TaskLifecycleTransitionService = {
  plan(
    snapshot: TaskLifecycleTransitionSnapshot,
    commandInput: TaskCompleteTransitionCommand
  ): CanonicalTaskMutationPlan {
    const command = decodeTaskCompleteTransitionCommand(commandInput);
    if (snapshot.taskId !== command.taskId) {
      throw planning("TASK_LIFECYCLE_SNAPSHOT_IDENTITY_MISMATCH", "Task lifecycle snapshot does not belong to the command task.");
    }
    assertLifecycleSnapshotCoherence(snapshot);
    const base: CanonicalTaskMutationPlanBase = {
      schema: "canonical-task-mutation-plan/v1",
      transitionId: taskLifecycleTransitionId(command.callerIdempotencyKey),
      callerIdempotencyKey: command.callerIdempotencyKey,
      taskId: command.taskId,
      command,
      verifiedExternalWitnesses: snapshot.verifiedExternalWitnesses,
      completionContractBodySha256: snapshot.completionContractBodySha256
    };
    if (snapshot.existingTransition) {
      const existing = snapshot.existingTransition;
      if (existing.transitionId !== base.transitionId
        || existing.callerIdempotencyKey !== base.callerIdempotencyKey
        || existing.taskId !== base.taskId
        || existing.terminalTaskStatus !== "done"
        || (existing.executionId === null) !== (existing.terminalExecutionState === null)
        || (existing.committedCase === "commit-anchor") !== (existing.executionId === null)) {
        throw planning("TASK_LIFECYCLE_TRANSITION_IDEMPOTENCY_CONFLICT", "The stored lifecycle transition does not match the caller idempotency identity.");
      }
      return {
        ...base,
        kind: "already-committed",
        committedCase: existing.committedCase,
        executionId: existing.executionId
      };
    }
    switch (command.evidenceMode) {
      case "commit-anchor": {
        if (!snapshot.commitEvidence) {
          throw planning("TASK_LIFECYCLE_COMMIT_EVIDENCE_REQUIRED", "Commit-anchor completion requires server-produced completion evidence.");
        }
        return { ...base, kind: "commit-anchor", evidence: snapshot.commitEvidence };
      }
      case "execution-review":
        return planExecutionReview(snapshot, command, base);
      default:
        return lifecyclePlannerNever(command.evidenceMode);
    }
  }
} as const;

export function taskLifecycleTransitionId(callerIdempotencyKey: string): string {
  return `trn_${sha256Text(callerIdempotencyKey).slice(0, 32)}`;
}

export function resolveTaskCurrentRound(input: {
  readonly taskId: string;
  readonly executionId?: string | null;
  readonly documents: ReadonlyArray<{ readonly path: string; readonly body: string }>;
}): TaskCurrentRound {
  const executions = decodeTaskExecutions(input.taskId, input.documents);
  if (input.executionId) {
    const selected = executions.find((candidate) => candidate.execution_id === input.executionId);
    if (!selected) {
      return manual("selected-round-not-found", [input.executionId]);
    }
    const otherOpen = executions.filter((candidate) =>
      candidate.execution_id !== selected.execution_id
      && (candidate.state === "active" || candidate.state === "submitted")
    );
    if (otherOpen.length > 0) {
      return manual("multiple-open-rounds", [selected, ...otherOpen].map((candidate) => candidate.execution_id));
    }
    return selectedRound(selected);
  }

  const open = executions.filter((candidate) => candidate.state === "active" || candidate.state === "submitted");
  if (open.length > 1) return manual("multiple-open-rounds", open.map((candidate) => candidate.execution_id));
  if (open.length === 1) return selectedRound(open[0]!);
  const accepted = executions.filter((candidate) => candidate.state === "accepted");
  if (accepted.length > 1) return manual("multiple-accepted-history", accepted.map((candidate) => candidate.execution_id));
  if (accepted.length === 1) return { kind: "accepted-replay", execution: accepted[0]! };
  return manual("no-current-round", []);
}

export function decodeCanonicalTaskMutationPlan(value: unknown): CanonicalTaskMutationPlan {
  const row = lifecycleRecord(value, "canonical task mutation plan");
  lifecycleExactKeys(row, [
    "schema", "kind", "transitionId", "callerIdempotencyKey", "taskId", "command",
    "verifiedExternalWitnesses", "completionContractBodySha256"
  ], ["executionId", "reviewId", "consentId", "approvedReviewId", "consumedConsentId", "evidence", "committedCase"]);
  if (row.schema !== "canonical-task-mutation-plan/v1") lifecycleInvalid("canonical task mutation plan.schema");
  const command = decodeTaskCompleteTransitionCommand(row.command, "canonical task mutation plan.command");
  const transitionId = lifecycleText(row.transitionId, "canonical task mutation plan.transitionId");
  const callerIdempotencyKey = lifecycleText(row.callerIdempotencyKey, "canonical task mutation plan.callerIdempotencyKey");
  const taskId = lifecycleText(row.taskId, "canonical task mutation plan.taskId");
  if (transitionId !== taskLifecycleTransitionId(callerIdempotencyKey)
    || command.callerIdempotencyKey !== callerIdempotencyKey
    || command.taskId !== taskId) {
    lifecycleInvalid("canonical task mutation plan identity binding");
  }
  const base: CanonicalTaskMutationPlanBase = {
    schema: "canonical-task-mutation-plan/v1",
    transitionId,
    callerIdempotencyKey,
    taskId,
    command,
    verifiedExternalWitnesses: verifiedWitnesses(row.verifiedExternalWitnesses),
    completionContractBodySha256: lifecycleNullableDigest(row.completionContractBodySha256)
  };
  switch (row.kind) {
    case "execution-review":
      exactVariantFields(row, ["executionId", "reviewId", "consentId"]);
      return {
        ...base,
        kind: row.kind,
        executionId: lifecycleText(row.executionId, "canonical task mutation plan.executionId"),
        reviewId: lifecycleText(row.reviewId, "canonical task mutation plan.reviewId"),
        consentId: lifecycleText(row.consentId, "canonical task mutation plan.consentId")
      };
    case "accepted-replay":
      exactVariantFields(row, ["executionId", "approvedReviewId", "consumedConsentId"]);
      return {
        ...base,
        kind: row.kind,
        executionId: lifecycleText(row.executionId, "canonical task mutation plan.executionId"),
        approvedReviewId: lifecycleText(row.approvedReviewId, "canonical task mutation plan.approvedReviewId"),
        consumedConsentId: lifecycleText(row.consumedConsentId, "canonical task mutation plan.consumedConsentId")
      };
    case "commit-anchor":
      exactVariantFields(row, ["evidence"]);
      return { ...base, kind: row.kind, evidence: row.evidence as TaskCompletionEvidence };
    case "already-committed":
      exactVariantFields(row, ["committedCase", "executionId"]);
      return {
        ...base,
        kind: row.kind,
        committedCase: lifecycleCase(row.committedCase, "canonical task mutation plan.committedCase"),
        executionId: row.executionId === null
          ? null
          : lifecycleText(row.executionId, "canonical task mutation plan.executionId")
      };
    default:
      return lifecycleInvalid("canonical task mutation plan.kind");
  }
}

function planExecutionReview(
  snapshot: TaskLifecycleTransitionSnapshot,
  command: TaskCompleteTransitionCommand,
  base: CanonicalTaskMutationPlanBase
): CanonicalTaskMutationPlan {
  switch (snapshot.currentRound.kind) {
    case "submitted": {
      if (!command.approval) {
        throw planning("TASK_LIFECYCLE_APPROVAL_REQUIRED", "The submitted current round requires approval in the same transition command.");
      }
      const executionId = snapshot.currentRound.execution.execution_id;
      if (command.executionId && command.executionId !== executionId) {
        throw planning("TASK_LIFECYCLE_EXECUTION_ID_MISMATCH", "The command executionId does not match the resolved current round.");
      }
      if (command.approval.executionId && command.approval.executionId !== executionId) {
        throw planning("TASK_LIFECYCLE_APPROVAL_EXECUTION_ID_MISMATCH", "The approval executionId does not match the resolved current round.");
      }
      return {
        ...base,
        kind: "execution-review",
        executionId,
        reviewId: deterministicEntityId("rev", base.transitionId),
        consentId: command.approval.consentSource.kind === "recorded-consent"
          ? command.approval.consentSource.consentId
          : deterministicEntityId("cns", base.transitionId)
      };
    }
    case "accepted-replay": {
      const approval = snapshot.acceptedReplayApproval;
      if (!approval) {
        throw planning("TASK_LIFECYCLE_ACCEPTED_REPLAY_APPROVAL_REQUIRED", "Accepted replay requires one verified approved Review and consumed consent for the selected round.");
      }
      return {
        ...base,
        kind: "accepted-replay",
        executionId: snapshot.currentRound.execution.execution_id,
        approvedReviewId: approval.reviewId,
        consumedConsentId: approval.consentId
      };
    }
    case "active":
      throw planning("TASK_LIFECYCLE_EXECUTION_SUBMISSION_REQUIRED", `Execution ${snapshot.currentRound.execution.execution_id} is active and must be submitted before completion.`);
    case "manual-disposition":
      throw new TaskLifecycleTransitionPlanningError(
        "TASK_LIFECYCLE_CURRENT_ROUND_MANUAL_DISPOSITION",
        `Current round requires manual disposition: ${snapshot.currentRound.category} (${snapshot.currentRound.candidateExecutionIds.join(", ") || "none"}).`,
        snapshot.currentRound.category
      );
    default:
      return lifecyclePlannerNever(snapshot.currentRound);
  }
}

function assertLifecycleSnapshotCoherence(snapshot: TaskLifecycleTransitionSnapshot): void {
  if (snapshot.holder.taskId !== snapshot.taskId || !snapshot.sessionBinding.sessionId) {
    throw planning("TASK_LIFECYCLE_SNAPSHOT_IDENTITY_MISMATCH", "Task holder and session binding must belong to the lifecycle snapshot.");
  }
  if (snapshot.holder.effectiveHolder !== null) {
    throw planning(
      "TASK_LIFECYCLE_HOLDER_RELEASE_REQUIRED",
      "Task lifecycle completion requires an unheld task; the submitted-round boundary must release its holder before a terminal transition can be planned."
    );
  }
  const selectedExecutionId = snapshot.currentRound.kind === "manual-disposition"
    ? null
    : snapshot.currentRound.execution.execution_id;
  const holder = snapshot.holder.holder;
  if (selectedExecutionId && holder?.schema === "task-holder/v2"
    && (holder.phase !== "active" || holder.executionId !== selectedExecutionId)) {
    throw planning(
      "TASK_LIFECYCLE_HOLDER_ROUND_MISMATCH",
      `The holder snapshot is bound to ${holder.executionId}/${holder.phase}, not current round ${selectedExecutionId}.`
    );
  }
}

function decodeTaskExecutions(
  taskId: string,
  documents: ReadonlyArray<{ readonly path: string; readonly body: string }>
): ReadonlyArray<ExecutionRecord> {
  return documents
    .filter((document) => /^executions\/[^/]+\.md$/u.test(document.path))
    .map((document) => {
      const execution = Schema.decodeUnknownSync(executionDeclaration.schema)(
        executionDeclaration.documentCodec.decode(document.body)
      ) as ExecutionRecord;
      if (document.path !== `executions/${execution.execution_id}.md`
        || execution.task_ref !== `task/${taskId}`) {
        throw planning("TASK_LIFECYCLE_EXECUTION_IDENTITY_MISMATCH", `Execution identity does not match host path ${document.path}.`);
      }
      return execution;
    });
}

function selectedRound(execution: ExecutionRecord): TaskCurrentRound {
  switch (execution.state) {
    case "active": return { kind: "active", execution };
    case "submitted": return { kind: "submitted", execution };
    case "accepted": return { kind: "accepted-replay", execution };
    case "changes_requested":
    case "abandoned":
      return manual("no-current-round", [execution.execution_id]);
    default:
      return lifecyclePlannerNever(execution.state);
  }
}

function manual(category: TaskCurrentRoundManualCategory, ids: ReadonlyArray<string>): TaskCurrentRound {
  return { kind: "manual-disposition", category, candidateExecutionIds: [...ids].sort() };
}

function deterministicEntityId(prefix: "rev" | "cns", transitionId: string): string {
  return `${prefix}_${sha256Text(`${prefix}:${transitionId}`).slice(0, 26).toUpperCase()}`;
}

function planning(code: string, message: string): TaskLifecycleTransitionPlanningError {
  return new TaskLifecycleTransitionPlanningError(code, message);
}

function verifiedWitnesses(value: unknown): ReadonlyArray<VerifiedTaskCompleteExternalWitness> {
  if (!Array.isArray(value)) lifecycleInvalid("canonical task mutation plan.verifiedExternalWitnesses");
  return value.map((entry, index) => {
    const row = lifecycleRecord(entry, `verified witness ${index}`);
    if (row.kind === "document-publication") {
      lifecycleExactKeys(row, ["kind", "ref", "repositoryCommit", "publicationOperationIds", "coveredTaskRelativePaths", "coveredPathSetDigest"], []);
      return {
        kind: row.kind,
        ref: lifecycleText(row.ref, "verified witness.ref"),
        repositoryCommit: sha(row.repositoryCommit, "verified witness.repositoryCommit"),
        publicationOperationIds: lifecycleStringArray(row.publicationOperationIds, "verified witness.publicationOperationIds"),
        coveredTaskRelativePaths: lifecycleStringArray(row.coveredTaskRelativePaths, "verified witness.coveredTaskRelativePaths"),
        coveredPathSetDigest: lifecycleDigest(row.coveredPathSetDigest, "verified witness.coveredPathSetDigest")
      };
    }
    if (row.kind === "code-doc-reconciliation") {
      lifecycleExactKeys(row, ["kind", "ref", "repositoryCommit", "publicationOperationIds", "taskId", "reconciledCommitRef", "normalizedPaths", "prRef", "codeDocBodyDigest"], []);
      return {
        kind: row.kind,
        ref: lifecycleText(row.ref, "verified witness.ref"),
        repositoryCommit: sha(row.repositoryCommit, "verified witness.repositoryCommit"),
        publicationOperationIds: lifecycleStringArray(row.publicationOperationIds, "verified witness.publicationOperationIds"),
        taskId: lifecycleText(row.taskId, "verified witness.taskId"),
        reconciledCommitRef: sha(row.reconciledCommitRef, "verified witness.reconciledCommitRef"),
        normalizedPaths: lifecycleStringArray(row.normalizedPaths, "verified witness.normalizedPaths"),
        prRef: row.prRef === null ? null : lifecycleText(row.prRef, "verified witness.prRef"),
        codeDocBodyDigest: lifecycleDigest(row.codeDocBodyDigest, "verified witness.codeDocBodyDigest")
      };
    }
    return lifecycleInvalid(`verified witness ${index}.kind`);
  });
}

function lifecycleRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) lifecycleInvalid(label);
  return value as Record<string, unknown>;
}

function lifecycleExactKeys(row: Record<string, unknown>, required: ReadonlyArray<string>, optional: ReadonlyArray<string>): void {
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(row, key)) || Object.keys(row).some((key) => !allowed.has(key))) lifecycleInvalid("canonical task mutation plan fields");
}

function exactVariantFields(row: Record<string, unknown>, variant: ReadonlyArray<string>): void {
  const common = new Set(["schema", "kind", "transitionId", "callerIdempotencyKey", "taskId", "command", "verifiedExternalWitnesses", "completionContractBodySha256", ...variant]);
  if (Object.keys(row).some((key) => !common.has(key))) lifecycleInvalid("canonical task mutation plan variant fields");
}

function lifecycleText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value) lifecycleInvalid(label);
  return value;
}

function sha(value: unknown, label: string): string {
  const result = lifecycleText(value, label);
  if (!/^[0-9a-f]{40}$/u.test(result)) lifecycleInvalid(label);
  return result;
}

function lifecycleDigest(value: unknown, label: string): string {
  const result = lifecycleText(value, label);
  if (!/^sha256:[0-9a-f]{64}$/u.test(result)) lifecycleInvalid(label);
  return result;
}

function lifecycleNullableDigest(value: unknown): string | null {
  if (value === null) return null;
  const result = lifecycleText(value, "canonical task mutation plan.completionContractBodySha256");
  if (!/^[0-9a-f]{64}$/u.test(result)) lifecycleInvalid("canonical task mutation plan.completionContractBodySha256");
  return result;
}

function lifecycleCase(
  value: unknown,
  label: string
): "execution-review" | "accepted-replay" | "commit-anchor" {
  if (value === "execution-review" || value === "accepted-replay" || value === "commit-anchor") return value;
  return lifecycleInvalid(label);
}

function lifecycleStringArray(value: unknown, label: string): ReadonlyArray<string> {
  if (!Array.isArray(value)) lifecycleInvalid(label);
  return value.map((entry) => lifecycleText(entry, label));
}

function lifecycleInvalid(label: string): never {
  throw new Error(`CANONICAL_TASK_MUTATION_PLAN_INVALID:${label}`);
}

function lifecyclePlannerNever(value: never): never {
  throw new Error(`TASK_LIFECYCLE_EXHAUSTIVENESS_BREACH:${String(value)}`);
}

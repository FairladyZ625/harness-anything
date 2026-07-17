import { Effect, Schema } from "effect";
import {
  computeExecutionConsentPin,
  consentDeclaration,
  executionDeclaration,
  reviewDeclaration,
  sha256Text,
  stablePayloadHash,
  writeDeclaredEntityTransaction,
  type ArtifactStore,
  type ConsentRecord,
  type ExecutionRecord,
  type HarnessLayoutInput,
  type ReviewRecord,
  type TaskHolderPrincipal,
  type WriteCoordinator
} from "../../kernel/src/index.ts";
import { assertExecutionTaskCompletable, executionHasArchiveWarnings } from "./execution-review-helpers.ts";

export interface ExecutionCompletionService {
  readonly inspectTaskExecutionCompletion?: (input: {
    readonly taskId: string;
    readonly actor: TaskHolderPrincipal;
    readonly documents: ReadonlyArray<{ readonly path: string; readonly body: string }>;
  }) => ExecutionCompletionReadiness;
  readonly completeTaskExecution: (input: {
    readonly taskId: string;
    readonly actor: TaskHolderPrincipal;
  }) => Promise<{ readonly executionId: string } | null>;
}

export interface ExecutionCompletionReadinessIssue {
  readonly code:
    | "execution_submission_required"
    | "execution_task_not_in_review"
    | "execution_review_required"
    | "archive_warnings_acknowledgement_required";
  readonly message: string;
  readonly nextCommand?: string;
}

export interface ExecutionCompletionReadiness {
  readonly ok: boolean;
  readonly executionId?: string;
  readonly issues: ReadonlyArray<ExecutionCompletionReadinessIssue>;
}

export function makeExecutionCompletionService(options: {
  readonly rootInput: HarnessLayoutInput;
  readonly coordinator: WriteCoordinator;
  readonly artifactStore: Pick<ArtifactStore, "readTaskPackage">;
  readonly now?: () => string;
}): ExecutionCompletionService {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    inspectTaskExecutionCompletion: inspectExecutionCompletionReadiness,
    completeTaskExecution: async ({ taskId, actor }) => {
      const task = await Effect.runPromise(options.artifactStore.readTaskPackage(taskId));
      const readiness = resolveExecutionCompletionReadiness({ taskId, actor, documents: task.documents });
      if (!readiness.execution) {
        if (!task.documents.some((document) => /^executions\/[^/]+\.md$/u.test(document.path))) return null;
        throw new Error(readiness.issues[0]?.message ?? `task ${taskId} requires exactly one submitted Execution`);
      }
      if (!readiness.ok) throw new Error(readiness.issues[0]?.message ?? `task ${taskId} is not ready for Execution completion`);
      const execution = readiness.execution;

      const completedAt = now();
      const staleActiveWrites = readiness.staleActive.map((candidate) => ({
        taskId,
        path: `executions/${candidate.execution_id}.md`,
        body: executionDeclaration.documentCodec.encode({
          ...candidate,
          state: "abandoned" as const,
          closed_at: completedAt
        })
      }));
      await Effect.runPromise(writeDeclaredEntityTransaction(
        options.coordinator,
        stablePayloadHash,
        executionDeclaration,
        { taskId, executionId: execution.execution_id },
        { ...execution, state: "accepted", closed_at: completedAt },
        [
          { taskId, path: "INDEX.md", body: completedTaskIndex(task.documents, taskId) },
          ...staleActiveWrites
        ],
        completionPreconditions(task.documents, taskId)
      ));
      return { executionId: execution.execution_id };
    }
  };
}

function completionPreconditions(
  documents: ReadonlyArray<{ readonly path: string; readonly body: string }>,
  taskId: string
): ReadonlyArray<{ readonly taskId: string; readonly path: string; readonly bodySha256: string }> {
  return documents
    .filter((document) => document.path === "INDEX.md"
      || /^executions\/[^/]+\.md$/u.test(document.path)
      || /^reviews\/[^/]+\.md$/u.test(document.path)
      || /^consents\/[^/]+\.md$/u.test(document.path))
    .map((document) => ({ taskId, path: document.path, bodySha256: sha256Text(document.body) }));
}

export function inspectExecutionCompletionReadiness(input: {
  readonly taskId: string;
  readonly actor: TaskHolderPrincipal;
  readonly documents: ReadonlyArray<{ readonly path: string; readonly body: string }>;
}): ExecutionCompletionReadiness {
  const readiness = resolveExecutionCompletionReadiness(input);
  return {
    ok: readiness.ok,
    ...(readiness.execution ? { executionId: readiness.execution.execution_id } : {}),
    issues: readiness.issues
  };
}

function resolveExecutionCompletionReadiness(input: {
  readonly taskId: string;
  readonly actor: TaskHolderPrincipal;
  readonly documents: ReadonlyArray<{ readonly path: string; readonly body: string }>;
}): ExecutionCompletionReadiness & {
  readonly execution?: ExecutionRecord;
  readonly staleActive: ReadonlyArray<ExecutionRecord>;
} {
  const executions = input.documents
    .filter((document) => /^executions\/[^/]+\.md$/u.test(document.path))
    .map((document) => {
      const execution = Schema.decodeUnknownSync(executionDeclaration.schema)(
        executionDeclaration.documentCodec.decode(document.body)
      ) as ExecutionRecord;
      if (document.path !== `executions/${execution.execution_id}.md` || execution.task_ref !== `task/${input.taskId}`) {
        throw new Error(`execution identity does not match its host path: ${document.path}`);
      }
      return execution;
    });
  const submitted = executions.filter((candidate) => candidate.state === "submitted");
  const staleActive = executions.filter((candidate) => candidate.state === "active");
  if (submitted.length !== 1) {
    const claimCommand = staleActive.length === 1
      ? `ha task claim ${input.taskId} --execution-id ${staleActive[0]!.execution_id}`
      : staleActive.length > 1
        ? `ha task claim ${input.taskId} --execution-id <authoritative-active-execution-id>`
        : `ha task claim ${input.taskId}`;
    const nextCommand = submitted.length > 1
      ? `ha task review-execution ${input.taskId} --execution-id <one-to-retire> --verdict changes_requested --findings "<why this round is superseded>" --rationale "<why another submitted round remains authoritative>"`
      : `${claimCommand}\nha task transition ${input.taskId} in_review --lease-token <leaseToken-from-claim-receipt> --completion-claim "<claim>"`;
    return {
      ok: false,
      staleActive,
      issues: [{
        code: "execution_submission_required",
        message: `Task completion requires exactly one submitted Execution; found ${submitted.length}${submitted.length > 1 ? ` (${submitted.map((candidate) => candidate.execution_id).join(", ")})` : ""}.`,
        nextCommand
      }]
    };
  }

  const execution = submitted[0]!;
  const issues: ExecutionCompletionReadinessIssue[] = [];
  try {
    assertExecutionTaskCompletable(input.documents, input.taskId);
  } catch (error) {
    issues.push({
      code: "execution_task_not_in_review",
      message: error instanceof Error ? error.message : String(error)
    });
  }
  const reviews = input.documents
    .filter((document) => /^reviews\/[^/]+\.md$/u.test(document.path))
    .map((document) => {
      const review = Schema.decodeUnknownSync(reviewDeclaration.schema)(
        reviewDeclaration.documentCodec.decode(document.body)
      ) as ReviewRecord;
      if (document.path !== `reviews/${review.review_id}.md` || review.task_ref !== `task/${input.taskId}`) {
        throw new Error(`review identity does not match its host path: ${document.path}`);
      }
      return review;
    });
  const executionRef = `execution/${input.taskId}/${execution.execution_id}`;
  const approved = reviews.filter((review) =>
    review.task_ref === `task/${input.taskId}` &&
    review.execution_ref === executionRef &&
    review.verdict === "approved" &&
    reviewHasCompletionConsent(review, execution, input.documents, input.taskId)
  );
  if (approved.length === 0) {
    issues.push({
      code: "execution_review_required",
      message: `Submitted Execution ${execution.execution_id} requires an approved Review backed by consumed human consent that grants complete_task and matches the current content pin. Changing HARNESS_ACTOR or executor identity does not satisfy this gate.`,
      nextCommand: `ha task review-execution ${input.taskId} --execution-id ${execution.execution_id} --verdict approved --findings "<what was verified>" --rationale "<why the evidence satisfies the task>" --consent-utterance "<the human's exact words>"`
    });
  } else if (executionHasArchiveWarnings(execution) && !approved.some((review) => review.archive_warnings_acknowledged)) {
    issues.push({
      code: "archive_warnings_acknowledgement_required",
      message: `Approved Review must acknowledge archive warnings for Execution ${execution.execution_id}.`
    });
  }

  return { ok: issues.length === 0, executionId: execution.execution_id, execution, staleActive, issues };
}

function reviewHasCompletionConsent(
  review: ReviewRecord,
  execution: ExecutionRecord,
  documents: ReadonlyArray<{ readonly path: string; readonly body: string }>,
  taskId: string
): boolean {
  const basis = review.approval_basis;
  if (!basis || basis.kind !== "human-consent") return false;
  const consentRef = basis.consent_ref.match(/^consent\/(task_[^/]+)\/(cns_[^/]+)$/u);
  const consentId = consentRef?.[2];
  if (!consentId || consentRef?.[1] !== taskId) return false;
  const document = documents.find((candidate) => candidate.path === `consents/${consentId}.md`);
  if (!document) return false;
  let consent: ConsentRecord;
  try {
    consent = Schema.decodeUnknownSync(consentDeclaration.schema)(
      consentDeclaration.documentCodec.decode(document.body)
    ) as ConsentRecord;
  } catch {
    return false;
  }
  const reviewRef = `review/${taskId}/${review.review_id}`;
  const currentPin = computeExecutionConsentPin(execution);
  return consent.task_ref === `task/${taskId}`
    && consent.execution_ref === `execution/${taskId}/${execution.execution_id}`
    && consent.state === "consumed"
    && consent.consumed_by === reviewRef
    && consent.scope.actions.includes("complete_task")
    && basis.consent_snapshot.scope.actions.includes("complete_task")
    && consent.scope.content_pin.digest === currentPin
    && basis.consent_snapshot.scope.content_pin.digest === currentPin
    && consent.principal.personId === review.reviewer_actor.principal.personId
    && basis.consent_snapshot.principal.personId === consent.principal.personId
    && stablePayloadHash(basis.consent_snapshot) === stablePayloadHash({
      principal: consent.principal,
      scope: consent.scope,
      disclosure: consent.disclosure,
      channel: consent.channel,
      response: consent.response,
      recorded_by: consent.recorded_by,
      granted_at: consent.granted_at,
      expires_at: consent.expires_at
    });
}

function completedTaskIndex(documents: ReadonlyArray<{ readonly path: string; readonly body: string }>, taskId: string): string {
  const body = documents.find((document) => document.path === "INDEX.md")?.body;
  if (!body) throw new Error(`task INDEX.md missing: ${taskId}`);
  if (!/^  engine:\s*local$/mu.test(body)) throw new Error(`task is not local: ${taskId}`);
  return body.replace(/^(  status:\s*).+$/mu, "$1done");
}

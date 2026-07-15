import { Effect, Schema } from "effect";
import {
  executionDeclaration,
  reviewDeclaration,
  stablePayloadHash,
  writeDeclaredEntityTransaction,
  type ArtifactStore,
  type ExecutionRecord,
  type HarnessLayoutInput,
  type ReviewRecord,
  type TaskHolderPrincipal,
  type WriteCoordinator
} from "../../kernel/src/index.ts";
import { assertExecutionTaskInReview, executionActorsShareExecutor, executionHasArchiveWarnings } from "./execution-review-helpers.ts";

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
    | "execution_actor_cannot_complete"
    | "execution_review_required"
    | "archive_warnings_acknowledgement_required";
  readonly message: string;
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
      await Effect.runPromise(writeDeclaredEntityTransaction(
        options.coordinator,
        stablePayloadHash,
        executionDeclaration,
        { taskId, executionId: execution.execution_id },
        { ...execution, state: "accepted", closed_at: completedAt },
        [{ taskId, path: "INDEX.md", body: completedTaskIndex(task.documents, taskId) }]
      ));
      return { executionId: execution.execution_id };
    }
  };
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
}): ExecutionCompletionReadiness & { readonly execution?: ExecutionRecord } {
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
  if (submitted.length !== 1) {
    return {
      ok: false,
      issues: [{
        code: "execution_submission_required",
        message: `Task completion requires exactly one submitted Execution; found ${submitted.length}.`
      }]
    };
  }

  const execution = submitted[0]!;
  const issues: ExecutionCompletionReadinessIssue[] = [];
  try {
    assertExecutionTaskInReview(input.documents, input.taskId);
  } catch (error) {
    issues.push({
      code: "execution_task_not_in_review",
      message: error instanceof Error ? error.message : String(error)
    });
  }
  if (executionActorsShareExecutor(execution.primary_actor.executor, input.actor.executor)) {
    issues.push({
      code: "execution_actor_cannot_complete",
      message: `Execution executor cannot complete its own delivery: ${execution.execution_id}. Use a different authenticated executor.`
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
    !executionActorsShareExecutor(execution.primary_actor.executor, review.reviewer_actor.executor)
  );
  if (approved.length === 0) {
    issues.push({
      code: "execution_review_required",
      message: `Submitted Execution ${execution.execution_id} requires at least one approved Review from a different executor.`
    });
  } else if (executionHasArchiveWarnings(execution) && !approved.some((review) => review.archive_warnings_acknowledged)) {
    issues.push({
      code: "archive_warnings_acknowledgement_required",
      message: `Approved Review must acknowledge archive warnings for Execution ${execution.execution_id}.`
    });
  }

  return { ok: issues.length === 0, executionId: execution.execution_id, execution, issues };
}

function completedTaskIndex(documents: ReadonlyArray<{ readonly path: string; readonly body: string }>, taskId: string): string {
  const body = documents.find((document) => document.path === "INDEX.md")?.body;
  if (!body) throw new Error(`task INDEX.md missing: ${taskId}`);
  if (!/^  engine:\s*local$/mu.test(body)) throw new Error(`task is not local: ${taskId}`);
  return body.replace(/^(  status:\s*).+$/mu, "$1done");
}

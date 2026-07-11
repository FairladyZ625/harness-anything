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
  readonly completeTaskExecution: (input: {
    readonly taskId: string;
    readonly actor: TaskHolderPrincipal;
  }) => Promise<{ readonly executionId: string } | null>;
}

export function makeExecutionCompletionService(options: {
  readonly rootInput: HarnessLayoutInput;
  readonly coordinator: WriteCoordinator;
  readonly artifactStore: Pick<ArtifactStore, "readTaskPackage">;
  readonly now?: () => string;
}): ExecutionCompletionService {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    completeTaskExecution: async ({ taskId, actor }) => {
      const task = await Effect.runPromise(options.artifactStore.readTaskPackage(taskId));
      const executionDocuments = task.documents.filter((document) => /^executions\/[^/]+\.md$/u.test(document.path));
      if (executionDocuments.length === 0) return null;
      const executions = executionDocuments.map((document) => {
        const execution = Schema.decodeUnknownSync(executionDeclaration.schema)(
          executionDeclaration.documentCodec.decode(document.body)
        ) as ExecutionRecord;
        if (document.path !== `executions/${execution.execution_id}.md` || execution.task_ref !== `task/${taskId}`) {
          throw new Error(`execution identity does not match its host path: ${document.path}`);
        }
        return execution;
      });
      const execution = executions
        .filter((candidate) => candidate.state === "submitted")
        .sort((left, right) => `${right.submitted_at ?? ""}:${right.execution_id}`.localeCompare(`${left.submitted_at ?? ""}:${left.execution_id}`))[0];
      if (!execution) throw new Error(`task ${taskId} has Execution history but no submitted Execution`);
      assertExecutionTaskInReview(task.documents, taskId);
      if (executionActorsShareExecutor(execution.primary_actor.executor, actor.executor)) {
        throw new Error(`execution executor cannot complete its own delivery: ${execution.execution_id}`);
      }

      const reviews = task.documents
        .filter((document) => /^reviews\/[^/]+\.md$/u.test(document.path))
        .map((document) => Schema.decodeUnknownSync(reviewDeclaration.schema)(
          reviewDeclaration.documentCodec.decode(document.body)
        ) as ReviewRecord);
      const executionRef = `execution/${taskId}/${execution.execution_id}`;
      const approved = reviews.filter((review) =>
        review.task_ref === `task/${taskId}` &&
        review.execution_ref === executionRef &&
        review.verdict === "approved" &&
        !executionActorsShareExecutor(execution.primary_actor.executor, review.reviewer_actor.executor)
      );
      if (approved.length === 0) throw new Error(`submitted Execution ${execution.execution_id} requires at least one approved Review`);
      if (executionHasArchiveWarnings(execution) && !approved.some((review) => review.archive_warnings_acknowledged)) {
        throw new Error(`approved Review must acknowledge archive warnings for Execution ${execution.execution_id}`);
      }

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

function completedTaskIndex(documents: ReadonlyArray<{ readonly path: string; readonly body: string }>, taskId: string): string {
  const body = documents.find((document) => document.path === "INDEX.md")?.body;
  if (!body) throw new Error(`task INDEX.md missing: ${taskId}`);
  if (!/^  engine:\s*local$/mu.test(body)) throw new Error(`task is not local: ${taskId}`);
  return body.replace(/^(  status:\s*).+$/mu, "$1done");
}

import { Effect, Schema } from "effect";
import {
  executionDeclaration,
  generateTaskId,
  reviewDeclaration,
  stablePayloadHash,
  writeDeclaredEntityTransaction,
  type ArtifactStore,
  type CurrentSessionRef,
  type ExecutionRecord,
  type HarnessLayoutInput,
  type ReviewRecord,
  type ReviewVerdict,
  type TaskHolderPrincipal,
  type WriteCoordinator
} from "../../kernel/src/index.ts";
import { assertExecutionTaskInReview, executionActorsShareExecutor, executionHasArchiveWarnings } from "./execution-review-helpers.ts";

export interface ReviewExecutionService {
  readonly reviewExecution: (input: {
    readonly taskId: string;
    readonly executionId: string;
    readonly reviewer: TaskHolderPrincipal;
    readonly reviewerSession: CurrentSessionRef;
    readonly findings: string;
    readonly evidenceChecked: ReadonlyArray<string>;
    readonly rationale: string;
    readonly verdict: ReviewVerdict;
    readonly archiveWarningsAcknowledged: boolean;
  }) => Promise<{ readonly review: ReviewRecord }>;
}

export function makeReviewExecutionService(options: {
  readonly rootInput: HarnessLayoutInput;
  readonly coordinator: WriteCoordinator;
  readonly artifactStore: Pick<ArtifactStore, "readTaskPackage">;
  readonly generateReviewId?: () => string;
  readonly now?: () => string;
}): ReviewExecutionService {
  const generateReviewId = options.generateReviewId ?? (() => `rev_${generateTaskId().slice("task_".length)}`);
  const now = options.now ?? (() => new Date().toISOString());
  return {
    reviewExecution: async (input) => {
      const task = await Effect.runPromise(options.artifactStore.readTaskPackage(input.taskId));
      const executionDocument = task.documents.find((document) => document.path === `executions/${input.executionId}.md`);
      if (!executionDocument) throw new Error(`execution not found: ${input.executionId}`);
      const execution = Schema.decodeUnknownSync(executionDeclaration.schema)(
        executionDeclaration.documentCodec.decode(executionDocument.body)
      ) as ExecutionRecord;
      if (execution.execution_id !== input.executionId || execution.task_ref !== `task/${input.taskId}`) {
        throw new Error(`execution identity does not match its host path: ${input.executionId}`);
      }
      if (execution.state !== "submitted") throw new Error(`execution is not submitted: ${input.executionId}`);
      assertExecutionTaskInReview(task.documents, input.taskId);
      if (executionActorsShareExecutor(execution.primary_actor.executor, input.reviewer.executor)) {
        throw new Error(`execution executor cannot review its own delivery: ${input.executionId}`);
      }
      if (executionHasArchiveWarnings(execution) && !input.archiveWarningsAcknowledged) {
        throw new Error("execution archive warnings must be explicitly acknowledged by the reviewer");
      }
      const evidenceIds = new Set(execution.outputs.map((evidence) => evidence.evidence_id));
      const unknownEvidence = input.evidenceChecked.find((evidenceId) => !evidenceIds.has(evidenceId));
      if (unknownEvidence) throw new Error(`review evidence does not belong to execution ${input.executionId}: ${unknownEvidence}`);

      const reviewId = generateReviewId();
      if (task.documents.some((document) => document.path === `reviews/${reviewId}.md`)) {
        throw new Error(`review already exists: ${reviewId}`);
      }
      const reviewedAt = now();
      const review: ReviewRecord = {
        schema: "review/v2",
        review_id: reviewId,
        task_ref: `task/${input.taskId}`,
        execution_ref: `execution/${input.taskId}/${input.executionId}`,
        reviewer_actor: input.reviewer,
        reviewer_session_ref: `session/${input.reviewerSession.sessionId}`,
        findings: input.findings,
        evidence_checked: input.evidenceChecked,
        rationale: input.rationale,
        verdict: input.verdict,
        archive_warnings_acknowledged: input.archiveWarningsAcknowledged,
        reviewed_at: reviewedAt
      };
      const companionWrites = input.verdict === "changes_requested"
        ? [
            {
              taskId: input.taskId,
              path: `executions/${input.executionId}.md`,
              body: executionDeclaration.documentCodec.encode({ ...execution, state: "changes_requested", closed_at: reviewedAt })
            },
            {
              taskId: input.taskId,
              path: "INDEX.md",
              body: activeTaskIndex(task.documents, input.taskId)
            }
          ]
        : [];
      await Effect.runPromise(writeDeclaredEntityTransaction(
        options.coordinator,
        stablePayloadHash,
        reviewDeclaration,
        { taskId: input.taskId, reviewId },
        review,
        companionWrites
      ));
      return { review };
    }
  };
}

function activeTaskIndex(
  documents: ReadonlyArray<{ readonly path: string; readonly body: string }>,
  taskId: string
): string {
  const body = documents.find((document) => document.path === "INDEX.md")?.body;
  if (!body) throw new Error(`task INDEX.md missing: ${taskId}`);
  if (!/^  engine:\s*local$/mu.test(body)) throw new Error(`task is not local: ${taskId}`);
  return body.replace(/^(  status:\s*).+$/mu, "$1active");
}

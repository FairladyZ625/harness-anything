import { Effect } from "effect";
import { makeReviewExecutionService } from "../../../../application/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";

type Action = Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "task-review-execution" }>;

export function runExecutionReview(context: Parameters<CommandRunner>[0], action: Action): ReturnType<CommandRunner> {
  const service = makeReviewExecutionService({
    rootInput: context.layoutInput,
    coordinator: context.makeWriteCoordinator({ scope: "operational", kind: "agent", id: "execution-review" }),
    artifactStore: context.artifactStore
  });
  return context.currentSessionProbe.currentSession.pipe(
    Effect.flatMap((reviewerSession) => Effect.tryPromise({
      try: () => service.reviewExecution({
        taskId: action.taskId,
        executionId: action.executionId,
        reviewer: context.taskHolderPrincipal(),
        reviewerSession,
        findings: action.findings,
        evidenceChecked: action.evidenceChecked,
        rationale: action.rationale,
        verdict: action.verdict,
        archiveWarningsAcknowledged: action.archiveWarningsAcknowledged
      }),
      catch: (error) => error
    })),
    Effect.match({
      onFailure: (error): CliResult => ({
        ok: false,
        command: action.kind,
        taskId: action.taskId,
        executionId: action.executionId,
        error: cliError(CliErrorCode.WriteRejected, error instanceof Error ? error.message : String(error))
      }),
      onSuccess: ({ review }): CliResult => ({
        ok: true,
        command: action.kind,
        taskId: action.taskId,
        executionId: action.executionId,
        reviewId: review.review_id,
        report: {
          schema: "execution-review-result/v1",
          executionId: action.executionId,
          reviewId: review.review_id,
          verdict: review.verdict
        }
      })
    })
  );
}

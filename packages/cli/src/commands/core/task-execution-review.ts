import { Effect } from "effect";
import { makeReviewExecutionService } from "@harness-anything/application";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import { resolveExecutionConsentTtlMs } from "../project-policy-settings.ts";

type Action = Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "task-review-execution" }>;

export function runExecutionReview(context: Parameters<CommandRunner>[0], action: Action): ReturnType<CommandRunner> {
  if (!action.executionId) {
    return Effect.succeed({
      ok: false,
      command: action.kind,
      taskId: action.taskId,
      error: cliError(CliErrorCode.WriteRejected, action.executionSelectionError ?? "task review-execution requires --execution-id or exactly one submitted Execution.")
    } satisfies CliResult);
  }
  const consentTtl = resolveExecutionConsentTtlMs(context.layoutInput, process.env, action.kind);
  if (!consentTtl.ok) return Effect.succeed(consentTtl.result);
  const executionId = action.executionId;
  const generatedConsentId = action.generatedConsentId;
  const service = makeReviewExecutionService({
    rootInput: context.layoutInput,
    coordinator: context.makeWriteCoordinator({ scope: "operational", kind: "agent", id: "execution-review" }),
    artifactStore: context.artifactStore,
    consentTtlMs: consentTtl.ttlMs,
    ...(generatedConsentId ? { generateConsentId: () => generatedConsentId } : {})
  });
  return context.currentSessionProbe.currentSession.pipe(
    Effect.flatMap((reviewerSession) => Effect.tryPromise({
      try: () => service.reviewExecution({
        taskId: action.taskId,
        executionId,
        reviewer: context.taskHolderPrincipal(),
        reviewerSession,
        findings: action.findings,
        evidenceChecked: action.evidenceChecked,
        rationale: action.rationale,
        verdict: action.verdict,
        archiveWarningsAcknowledged: action.archiveWarningsAcknowledged,
        consentId: action.consentId,
        consentUtterance: action.consentUtterance,
        consentStandingPolicyDecisionId: action.consentStandingPolicyDecisionId,
        consentAssertedRationale: action.consentAssertedRationale,
        consentActions: action.consentActions
      }),
      catch: (error) => error
    })),
    Effect.match({
      onFailure: (error): CliResult => ({
        ok: false,
        command: action.kind,
        taskId: action.taskId,
        executionId,
        error: cliError(CliErrorCode.WriteRejected, error instanceof Error ? error.message : String(error))
      }),
      onSuccess: ({ review }): CliResult => ({
        ok: true,
        command: action.kind,
        taskId: action.taskId,
        executionId,
        reviewId: review.review_id,
        report: {
          schema: "execution-review-result/v1",
          executionId,
          reviewId: review.review_id,
          verdict: review.verdict
        }
      })
    })
  );
}

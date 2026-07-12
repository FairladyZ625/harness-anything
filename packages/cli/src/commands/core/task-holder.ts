import { Effect } from "effect";
import {
  makeCoordinatedExecutionAuthoredStore,
  makeExecutionSagaService,
  type TaskHolderPrincipal
} from "../../../../application/src/index.ts";
import { readSessionEntityDocument } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner, CommandRunnerContext } from "../../cli/runner-registry.ts";
import { resultForTaskHolderFailure, taskHolderCommandFailure, taskHolderPrincipal } from "./task-holder-support.ts";
type TaskHolderAction = Extract<
  Parameters<CommandRunner>[1]["action"],
  { readonly kind: "task-claim" | "task-holder" | "task-release" }
>;
function runExecutionClaim(
  context: CommandRunnerContext,
  action: Extract<TaskHolderAction, { readonly kind: "task-claim" }>,
  principal: TaskHolderPrincipal
): Effect.Effect<CliResult> {
  const saga = executionSaga(context);
  return context.currentSessionProbe.currentSession.pipe(
    Effect.flatMap((session) => Effect.promise(() => saga.claim({
      taskId: action.taskId,
      principal,
      ttlMs: action.ttlMs,
      primarySession: session.runtime === "human" ? null : session
    }))),
    Effect.map((result): CliResult => ({
      ok: true,
      command: "task-claim",
      taskId: action.taskId,
      executionId: result.executionId,
      report: {
        schema: "execution-claim-result/v1",
        executionId: result.executionId,
        leaseToken: result.leaseToken,
        leaseExpiresAt: result.leaseExpiresAt,
        actor: result.execution.primary_actor
      }
    }))
  );
}
export function runExecutionSubmit(
  context: CommandRunnerContext,
  action: Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "status-set" }>
): Effect.Effect<CliResult> {
  const principal = taskHolderPrincipal(context);
  if (!principal.ok) return Effect.succeed(principal.result);
  const saga = executionSaga(context);
  const submission = action.executionSubmission!;
  return Effect.gen(function* () {
    const snapshot = submission.executionId
      ? undefined
      : yield* Effect.promise(() => context.taskHolderService.holder({ taskId: action.taskId }));
    const executionId = submission.executionId ?? (snapshot?.holder?.schema === "task-holder/v2"
      ? snapshot.holder.executionId
      : undefined);
    if (!executionId) {
      return {
        ok: false,
        command: "status-set",
        taskId: action.taskId,
        error: cliError(CliErrorCode.WriteRejected, "Execution submit requires an active Holder V2 execution or an explicit --execution-id.")
      } satisfies CliResult;
    }
    return yield* Effect.tryPromise({
      try: () => saga.submitForReview({
        taskId: action.taskId,
        executionId,
        leaseToken: submission.leaseToken,
        principal: principal.value,
        submission: {
          completionClaim: submission.completionClaim,
          deliverables: submission.deliverables,
          verificationNotes: submission.verificationNotes,
          knownGaps: submission.knownGaps,
          residualRisks: submission.residualRisks,
          evidence: submission.outputs.map((text, index) => ({
            evidence_id: `ev_cli_${index + 1}`,
            execution_ref: `execution/${action.taskId}/${executionId}`,
            locator: { substrate: "inline" as const, text }
          }))
        }
      }),
      catch: (error) => error
    }).pipe(Effect.match({
      onFailure: (error): CliResult => ({
        ok: false,
        command: "status-set",
        taskId: action.taskId,
        executionId,
        status: "in_review",
        error: cliError(CliErrorCode.WriteRejected, error instanceof Error ? error.message : String(error))
      }),
      onSuccess: (): CliResult => ({
        ok: true,
        command: "status-set",
        taskId: action.taskId,
        executionId,
        status: "in_review",
        report: { schema: "execution-submit-result/v1", executionId, leaseReleased: true }
      })
    }));
  });
}

function executionSaga(context: CommandRunnerContext) {
  const coordinator = context.makeWriteCoordinator({ scope: "operational", kind: "agent", id: "execution-saga" });
  return makeExecutionSagaService({
    taskHolderService: context.taskHolderService,
    authoredStore: makeCoordinatedExecutionAuthoredStore({
      rootInput: context.layoutInput,
      coordinator,
      artifactStore: context.artifactStore
    }),
    finalizeSession: async (session) => {
      try {
        if (readSessionEntityDocument(context.layoutInput, session.sessionId).format === "manifest") return;
      } catch {
        // A missing or legacy Session is finalized through the existing exporter below.
      }
      const exported = await Effect.runPromise(context.provenanceSessionExporter.exportSession(session));
      await Effect.runPromise(context.syncExportedSession(exported));
    }
  });
}

export function runTaskClaim(
  context: CommandRunnerContext,
  action: Extract<TaskHolderAction, { readonly kind: "task-claim" }>
): Effect.Effect<CliResult> {
  return Effect.gen(function* () {
    const principal = taskHolderPrincipal(context);
    if (!principal.ok) return principal.result;
    if (action.execution) return yield* runExecutionClaim(context, action, principal.value);
    const session = yield* context.currentSessionProbe.currentSession;
    if (session.runtime !== "human") return yield* runExecutionClaim(context, action, principal.value);
    return yield* Effect.tryPromise({
      try: () => context.taskHolderService.claim({ taskId: action.taskId, principal: principal.value, ttlMs: action.ttlMs }),
      catch: taskHolderCommandFailure
    }).pipe(Effect.match({
      onFailure: (result): CliResult => resultForTaskHolderFailure("task-claim", action.taskId, result),
      onSuccess: (result): CliResult => ({
        ok: true,
        command: "task-claim",
        taskId: action.taskId,
        report: {
          schema: "task-holder-claim-result/v1",
          ...result
        }
      })
    }));
  });
}

export function runTaskHolder(
  context: CommandRunnerContext,
  action: Extract<TaskHolderAction, { readonly kind: "task-holder" }>
): Effect.Effect<CliResult> {
  return Effect.tryPromise({
    try: () => context.taskHolderService.holder({ taskId: action.taskId }),
    catch: taskHolderCommandFailure
  }).pipe(Effect.match({
    onFailure: (result): CliResult => resultForTaskHolderFailure("task-holder", action.taskId, result),
    onSuccess: (result): CliResult => ({
      ok: true,
      command: "task-holder",
      taskId: action.taskId,
      report: {
        schema: "task-holder-snapshot/v1",
        ...result
      }
    })
  }));
}

export function runTaskRelease(
  context: CommandRunnerContext,
  action: Extract<TaskHolderAction, { readonly kind: "task-release" }>
): Effect.Effect<CliResult> {
  return Effect.gen(function* () {
    const principal = taskHolderPrincipal(context);
    if (!principal.ok) return principal.result;
    return yield* Effect.tryPromise({
      try: () => context.taskHolderService.release({ taskId: action.taskId, principal: principal.value }),
      catch: taskHolderCommandFailure
    }).pipe(Effect.match({
      onFailure: (result): CliResult => resultForTaskHolderFailure("task-release", action.taskId, result),
      onSuccess: (result): CliResult => ({
        ok: true,
        command: "task-release",
        taskId: action.taskId,
        report: {
          schema: "task-holder-release-result/v1",
          ...result
        }
      })
    }));
  });
}

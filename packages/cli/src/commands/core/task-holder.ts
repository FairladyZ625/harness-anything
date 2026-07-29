import { Effect } from "effect";
import {
  readTaskLifecyclePolicy,
  type TaskHolderPrincipal
} from "@harness-anything/application";
import type { WriteError } from "@harness-anything/kernel";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import { toCliError } from "../../cli/error-mapper.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner, CommandRunnerContext } from "../../cli/runner-registry.ts";
import { milestoneDecisionLineageFailure } from "./task-lineage-gate.ts";
import { preflightActiveStatusSet } from "./task-active-transition.ts";
import { commandExecutionSaga } from "./task-holder-execution-saga.ts";
import { resultForTaskHolderFailure, taskHolderCommandFailure, taskHolderPrincipal } from "./task-holder-support.ts";
type TaskHolderAction = Extract<
  Parameters<CommandRunner>[1]["action"],
  { readonly kind: "task-claim" | "task-holder" | "task-release" }
>;
function runExecutionClaim(
  context: CommandRunnerContext,
  action: Extract<TaskHolderAction, { readonly kind: "task-claim" }>,
  principal: TaskHolderPrincipal,
  activation?: { readonly taskPlanBodySha256: string }
): Effect.Effect<CliResult> {
  const { authoredStore, saga } = commandExecutionSaga(context);
  return Effect.gen(function* () {
    if (activation) {
      const existing = yield* Effect.promise(() => authoredStore.listExecutions({ taskId: action.taskId }));
      if (existing.some((execution) => execution.state === "active")) {
        return {
          ok: false,
          command: "task-claim",
          taskId: action.taskId,
          error: cliError(
            CliErrorCode.WriteRejected,
            `Task ${action.taskId} is planned but already has an authored active Execution from a legacy split claim. Repair the lifecycle state before retrying; this command will not create or renew another lease.`
          )
        } satisfies CliResult;
      }
    }
    const session = yield* context.currentSessionProbe.currentSession;
    return yield* Effect.tryPromise({
      try: () => saga.claim({
        taskId: action.taskId,
        principal,
        ttlMs: action.ttlMs,
        primarySession: session.runtime === "human" ? null : session,
        executionId: action.executionId,
        ...(activation === undefined ? {} : { activation })
      }),
      catch: taskHolderCommandFailure
    }).pipe(Effect.match({
      onFailure: (result): CliResult => resultForTaskHolderFailure("task-claim", action.taskId, result),
      onSuccess: (result): CliResult => ({
        ok: true,
        command: "task-claim",
        taskId: action.taskId,
        executionId: result.executionId,
        report: {
          schema: "execution-claim-result/v1",
          executionId: result.executionId,
          leaseToken: result.leaseToken,
          acquiredAt: result.leaseAcquiredAt,
          leaseExpiresAt: result.leaseExpiresAt,
          reused: result.reused,
          actor: result.execution.primary_actor
        }
      })
    }));
  });
}
export function runExecutionSubmit(
  context: CommandRunnerContext,
  action: Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "status-set" }>
): Effect.Effect<CliResult> {
  const principal = taskHolderPrincipal(context);
  if (!principal.ok) return Effect.succeed(principal.result);
  const { authoredStore, saga } = commandExecutionSaga(context);
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
        error: cliError(CliErrorCode.WriteRejected, `Execution submit requires an active Holder V2 execution. Next: run \`ha task claim ${action.taskId}\`, then retry the same submit packet; use an explicit executionId only to select an existing active round.`)
      } satisfies CliResult;
    }
    const lineageFailure = milestoneDecisionLineageFailure(context, action.taskId, "status-set");
    if (lineageFailure) return { ...lineageFailure, executionId, status: "active" } satisfies CliResult;
    const submitted = yield* Effect.tryPromise({
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
      onFailure: (error) => ({ ok: false as const, error }),
      onSuccess: () => ({ ok: true as const })
    }));
    if (!submitted.ok) {
      return {
        ok: false,
        command: "status-set",
        taskId: action.taskId,
        executionId,
        status: "in_review",
        error: isTaskHolderWriteError(submitted.error)
          ? toCliError(submitted.error)
          : cliError(CliErrorCode.WriteRejected, submitted.error instanceof Error ? submitted.error.message : String(submitted.error))
      } satisfies CliResult;
    }
    const submittedExecution = yield* Effect.promise(() => authoredStore.readExecution({
      taskId: action.taskId,
      executionId
    }));
    const unavailableBindings = submittedExecution?.session_bindings
      .filter((binding) => binding.archive_status === "unavailable")
      .map((binding) => ({
        bindingId: binding.binding_id,
        sessionRef: binding.session_ref,
        archiveStatus: binding.archive_status
      })) ?? [];
    return {
      ok: true,
      command: "status-set",
      taskId: action.taskId,
      executionId,
      status: "in_review",
      report: {
        schema: "execution-submit-result/v1",
        executionId,
        leaseReleased: true,
        unavailableBindings
      }
    } satisfies CliResult;
  });
}

function isTaskHolderWriteError(error: unknown): error is WriteError {
  return typeof error === "object" && error !== null && "_tag" in error && [
    "WriteRejected", "WriteConflict", "GlobalWriteConflict", "JournalUnavailable"
  ].includes(String(error._tag));
}

export function runTaskClaim(
  context: CommandRunnerContext,
  action: Extract<TaskHolderAction, { readonly kind: "task-claim" }>
): Effect.Effect<CliResult> {
  return Effect.gen(function* () {
    const principal = taskHolderPrincipal(context);
    if (!principal.ok) return principal.result;
    const policy = yield* readTaskLifecyclePolicy(context.artifactStore, action.taskId);
    let activation: { readonly taskPlanBodySha256: string } | undefined;
    if (policy?.status === "planned") {
      const preflight = yield* preflightActiveStatusSet(context, action.taskId);
      if (!preflight.ok) {
        return {
          ...preflight.result,
          command: "task-claim",
          status: "planned"
        };
      }
      activation = { taskPlanBodySha256: preflight.taskPlanBodySha256 };
    }
    const claimed = yield* runExecutionClaim(context, action, principal.value, activation);
    if (!claimed.ok || policy?.status === null || policy?.status === undefined) return claimed;
    if (policy.status === "planned" && claimed.executionId) {
      return {
        ...claimed,
        status: "active",
        report: {
          ...(claimed.report ?? {}),
          activation: { schema: "task-claim-activation/v1", status: "active" }
        }
      };
    }
    return {
      ...claimed,
      status: policy.status
    };
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

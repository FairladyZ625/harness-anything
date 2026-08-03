import { Effect } from "effect";
import { readTaskLifecyclePolicy, type TaskHolderPrincipal } from "@harness-anything/application";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner, CommandRunnerContext } from "../../cli/runner-registry.ts";
import { preflightActiveStatusSet } from "./task-active-transition.ts";
import { commandExecutionSaga } from "./task-holder-execution-saga.ts";
import { canonicalTaskStartResult, resultForTaskHolderFailure, taskHolderCommandFailure, taskHolderPrincipal, terminalTaskStartFailure } from "./task-holder-support.ts";
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
            `Task ${action.taskId} has an incomplete pre-CH2 publication: its authored Execution is active while the Task is still planned. Repair the lifecycle state before retrying; task start will not create or renew another lease.`
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
export function runTaskClaim(
  context: CommandRunnerContext,
  action: Extract<TaskHolderAction, { readonly kind: "task-claim" }>
): Effect.Effect<CliResult> {
  return Effect.gen(function* () {
    const principal = taskHolderPrincipal(context);
    if (!principal.ok) return canonicalTaskStartResult(action.taskId, principal.result);
    const policy = yield* readTaskLifecyclePolicy(context.artifactStore, action.taskId);
    if (policy?.status === "done" || policy?.status === "cancelled") {
      return terminalTaskStartFailure(action.taskId, policy.status);
    }
    let activation: { readonly taskPlanBodySha256: string } | undefined;
    if (policy?.status === "planned") {
      const preflight = yield* preflightActiveStatusSet(context, action.taskId);
      if (!preflight.ok) {
        return canonicalTaskStartResult(action.taskId, {
          ...preflight.result,
          command: "task-claim",
          status: "planned"
        }, "planned");
      }
      activation = { taskPlanBodySha256: preflight.taskPlanBodySha256 };
    }
    const claimed = yield* runExecutionClaim(context, action, principal.value, activation);
    if (!claimed.ok) return canonicalTaskStartResult(action.taskId, claimed);
    if (policy?.status === null || policy?.status === undefined) return canonicalTaskStartResult(action.taskId, claimed);
    if (policy.status === "planned" && claimed.executionId) {
      return canonicalTaskStartResult(action.taskId, {
        ...claimed,
        status: "active",
        report: {
          ...(claimed.report ?? {}),
          activation: { schema: "task-claim-activation/v1", status: "active" }
        }
      });
    }
    return canonicalTaskStartResult(action.taskId, {
      ...claimed,
      status: policy.status
    }, policy.status);
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

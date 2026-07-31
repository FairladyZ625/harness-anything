import { Effect } from "effect";
import type { EngineError, WriteError } from "@harness-anything/kernel";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunnerContext } from "../../cli/runner-registry.ts";
import { leaseEnforcementEnabled } from "../settings.ts";
import { taskHolderCommandFailure, taskHolderPrincipal } from "./task-holder-support.ts";

export function withAuditedCancellationLease(
  context: CommandRunnerContext,
  taskId: string,
  operation: Effect.Effect<CliResult, EngineError | WriteError>
): Effect.Effect<CliResult, EngineError | WriteError> {
  if (!leaseEnforcementEnabled(context.layoutInput)) return operation;
  const principal = taskHolderPrincipal(context);
  if (!principal.ok) {
    return Effect.succeed({
      ...principal.result,
      command: "status-set",
      taskId,
      status: "cancelled"
    });
  }
  return Effect.gen(function* () {
    const holder = yield* Effect.tryPromise({
      try: () => context.taskHolderService.holder({ taskId }),
      catch: (error) => error
    }).pipe(Effect.match({
      onFailure: (error) => ({ ok: false as const, result: taskHolderCommandFailure(error) }),
      onSuccess: (snapshot) => ({ ok: true as const, snapshot })
    }));
    if (!holder.ok) {
      return { ...holder.result, command: "status-set", taskId, status: "cancelled" };
    }
    if (holder.snapshot.effectiveHolder) return yield* operation;

    const claim = yield* Effect.tryPromise({
      try: () => context.taskHolderService.claim({ taskId, principal: principal.value }),
      catch: (error) => error
    }).pipe(Effect.match({
      onFailure: (error) => ({ ok: false as const, result: taskHolderCommandFailure(error) }),
      onSuccess: () => ({ ok: true as const })
    }));
    if (!claim.ok) {
      return { ...claim.result, command: "status-set", taskId, status: "cancelled" };
    }
    return yield* operation.pipe(Effect.ensuring(
      Effect.tryPromise({
        try: () => context.taskHolderService.release({ taskId, principal: principal.value }),
        catch: () => undefined
      }).pipe(Effect.ignore)
    ));
  });
}

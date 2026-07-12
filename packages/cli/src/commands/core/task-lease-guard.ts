import { Effect } from "effect";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunnerContext } from "../../cli/runner-registry.ts";
import { leaseEnforcementEnabled } from "../settings.ts";
import { taskHolderCommandFailure, taskHolderPrincipal } from "./task-holder-support.ts";

export function activeTaskLeaseFailure(
  context: CommandRunnerContext,
  taskId: string,
  command: string
): Effect.Effect<CliResult | null> {
  if (!leaseEnforcementEnabled(context.layoutInput)) return Effect.succeed(null);
  const principal = taskHolderPrincipal(context);
  if (!principal.ok) return Effect.succeed({ ...principal.result, command, taskId });
  return Effect.tryPromise({
    try: () => context.taskHolderService.assertActiveLease({ taskId, principal: principal.value }),
    catch: taskHolderCommandFailure
  }).pipe(Effect.match({
    onFailure: (result): CliResult => ({ ...result, command, taskId }),
    onSuccess: () => null
  }));
}

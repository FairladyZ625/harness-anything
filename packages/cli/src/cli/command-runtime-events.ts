import { Effect } from "effect";
import { runtimeEventActorFromTaskHolderPrincipal } from "../../../application/src/index.ts";
import { runtimeEventPolicyForAction } from "./command-event-policy.ts";
import { cliError, CliErrorCode } from "./error-codes.ts";
import { actionTaskId } from "./parse-args.ts";
import type { CommandRunnerContext, CommandRunnerEffect } from "./runner-registry.ts";
import type { CliResult, ParsedCommand } from "./types.ts";

export function appendCommandRuntimeEvent(
  context: CommandRunnerContext,
  command: ParsedCommand,
  result: CliResult
): CommandRunnerEffect {
  if (runtimeEventPolicyForAction(command.action) !== "auto") return Effect.succeed(result);
  const entityRefs = eventEntityRefs(command.action, result);
  const errorCode = result.ok ? undefined : result.error?.code;
  const actor = commandRuntimeEventActor(context);
  return context.currentSessionProbe.currentSession.pipe(
    Effect.flatMap((session) => context.runtimeEventLedgerService.append({
      kind: "result",
      ...(actor ? { actor } : {}),
      session: {
        sessionId: session.sessionId,
        runtime: session.runtime,
        ...entityRefs
      },
      tool: {
        toolName: command.action.kind,
        ...(errorCode ? { errorCode } : {})
      },
      result: {
        status: result.ok ? "succeeded" : "failed",
        summary: `CLI command ${result.ok ? "succeeded" : "failed"}: ${command.action.kind}`,
        ...(errorCode ? { errorCode } : {})
      }
    })),
    Effect.match({
      onFailure: (error): CliResult => ({
        ...result,
        ...(result.ok
          ? {
            ok: false,
            command: command.action.kind,
            ...entityRefs,
            error: cliError(CliErrorCode.RuntimeEventLedgerRejected, `${error.sessionId}: ${error.reason}`)
          }
          : {})
      }),
      onSuccess: (): CliResult => result
    })
  );
}

function eventEntityRefs(
  action: ParsedCommand["action"],
  result: CliResult
): { readonly taskId?: string; readonly decisionId?: string; readonly factRef?: string } {
  const taskId = result.taskId ?? actionTaskId(action);
  const decisionId = result.decisionId ?? ("decisionId" in action ? action.decisionId : undefined);
  const factRef = result.factRef;
  return {
    ...(taskId ? { taskId } : {}),
    ...(decisionId ? { decisionId } : {}),
    ...(factRef ? { factRef } : {})
  };
}

function commandRuntimeEventActor(context: CommandRunnerContext) {
  try {
    return runtimeEventActorFromTaskHolderPrincipal(context.taskHolderPrincipal());
  } catch {
    return undefined;
  }
}

import { Effect } from "effect";
import { runtimeEventActorFromTaskHolderPrincipal } from "../../../application/src/index.ts";
import { runtimeEventPolicyForAction } from "./command-event-policy.ts";
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
  return context.currentSessionProbe.currentSession.pipe(
    Effect.flatMap((session) => Effect.try({
      try: () => runtimeEventActorFromTaskHolderPrincipal(context.taskHolderPrincipal()),
      catch: (error): RuntimeEventActorRejected => ({
        _tag: "RuntimeEventActorRejected",
        sessionId: session.sessionId,
        reason: runtimeEventActorResolutionMessage(error)
      })
    }).pipe(Effect.flatMap((actor) => context.runtimeEventLedgerService.append({
      kind: "result",
      actor,
      session: {
        sessionId: session.sessionId,
        runtime: session.runtime,
        ...entityRefs,
        executionId: entityRefs.executionId ?? null
      },
      tool: {
        toolName: command.action.kind,
        ...(errorCode ? { errorCode } : {}),
        ...(command.deprecatedInvocation ? { deprecated: true } : {})
      },
      result: {
        status: result.ok ? "succeeded" : "failed",
        summary: `CLI command ${result.ok ? "succeeded" : "failed"}: ${command.action.kind}`,
        ...(errorCode ? { errorCode } : {})
      }
    })))),
    Effect.match({
      onFailure: (error): CliResult => ({
        ...result,
        warnings: [
          ...(result.warnings ?? []),
          {
            severity: "warning",
            code: "runtime_event_append_failed",
            sessionId: error.sessionId,
            message: `Runtime event append failed after the command result was determined: ${error.reason}`
          }
        ]
      }),
      onSuccess: (): CliResult => result
    })
  );
}

interface RuntimeEventActorRejected {
  readonly _tag: "RuntimeEventActorRejected";
  readonly sessionId: string;
  readonly reason: string;
}

function runtimeEventActorResolutionMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function eventEntityRefs(
  action: ParsedCommand["action"],
  result: CliResult
): { readonly taskId?: string; readonly executionId?: string; readonly decisionId?: string; readonly factRef?: string } {
  const taskId = result.taskId ?? actionTaskId(action);
  const decisionId = result.decisionId ?? ("decisionId" in action ? action.decisionId : undefined);
  const factRef = result.factRef;
  const executionId = result.executionId ?? ("executionSubmission" in action ? action.executionSubmission?.executionId : undefined);
  return {
    ...(taskId ? { taskId } : {}),
    ...(executionId ? { executionId } : {}),
    ...(decisionId ? { decisionId } : {}),
    ...(factRef ? { factRef } : {})
  };
}

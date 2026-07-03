import { Effect } from "effect";
import type { RuntimeEventLedgerRejected } from "../../../../application/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import type { CliResult, ParsedCommand } from "../../cli/types.ts";

type RuntimeEventAppendAction = Extract<ParsedCommand["action"], { readonly kind: "runtime-event-append" }>;
type RuntimeEventListAction = Extract<ParsedCommand["action"], { readonly kind: "runtime-event-list" }>;

export const runRuntimeEventCommand: CommandRunner = (context, command) => {
  if (command.action.kind === "runtime-event-list") return runList(context, command.action);
  return runAppend(context, command.action as RuntimeEventAppendAction);
};

function runAppend(context: Parameters<CommandRunner>[0], action: RuntimeEventAppendAction) {
  return context.runtimeEventLedgerService.append({
    eventId: action.eventId,
    recordedAt: action.recordedAt,
    kind: action.eventKind,
    session: {
      sessionId: action.sessionId,
      runtime: action.runtime,
      ...(action.taskId ? { taskId: action.taskId } : {})
    },
    turn: action.turnId ? { turnId: action.turnId } : null,
    step: action.stepId ? { stepId: action.stepId } : null,
    tool: action.toolName ? { toolName: action.toolName } : null,
    approval: action.approval ? { decision: action.approval } : null,
    interrupt: action.interrupt ? { action: action.interrupt, ...(action.summary ? { reason: action.summary } : {}) } : null,
    result: action.result || action.summary ? { status: action.result ?? "unknown", ...(action.summary ? { summary: action.summary } : {}) } : null,
    cost: action.totalTokens === undefined ? null : { totalTokens: action.totalTokens }
  }).pipe(
    Effect.match({
      onFailure: runtimeEventFailure("runtime-event-append", action.sessionId),
      onSuccess: (result): CliResult => ({
        ok: true,
        command: "runtime-event-append",
        path: result.path,
        report: {
          schema: "runtime-event-ledger-cli-report/v1",
          eventId: result.event.eventId,
          kind: result.event.kind,
          sessionId: result.event.session.sessionId
        }
      })
    })
  );
}

function runList(context: Parameters<CommandRunner>[0], action: RuntimeEventListAction) {
  return context.runtimeEventLedgerService.readSession(action.sessionId).pipe(
    Effect.match({
      onFailure: runtimeEventFailure("runtime-event-list", action.sessionId),
      onSuccess: (result): CliResult => ({
        ok: true,
        command: "runtime-event-list",
        rows: result.events.length,
        path: result.path,
        report: {
          schema: "runtime-event-ledger-cli-report/v1",
          sessionId: result.sessionId,
          events: result.events
        }
      })
    })
  );
}

function runtimeEventFailure(command: "runtime-event-append" | "runtime-event-list", sessionId: string) {
  return (error: RuntimeEventLedgerRejected): CliResult => ({
    ok: false,
    command,
    error: cliError(CliErrorCode.RuntimeEventLedgerRejected, `${sessionId}: ${error.reason}`)
  });
}

import { Effect } from "effect";
import type { AuthenticatedActor, JsonObject } from "../../../daemon/src/index.ts";
import type { WriteCoordinator } from "../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import { toCommandReceipt, type CommandFailureReceipt, type CommandReceipt } from "../cli/receipt.ts";
import type { ParsedCommand } from "../cli/types.ts";
import { isPlainRecord } from "../cli/value-utils.ts";
import { CliActorAttributionError, daemonActorAttribution } from "../composition/actor-attribution.ts";
import { runRegisteredCommandWithCliComposition } from "../composition/command-executor.ts";
import { makeDaemonQueuedWriteCoordinator, type CliDaemonRuntime } from "./queued-write-coordinator.ts";

export interface CliCommandService {
  readonly runCommand: (payload?: JsonObject, context?: { readonly actor?: AuthenticatedActor }) => Promise<CommandReceipt | CommandFailureReceipt>;
}

export interface CliCommandServiceOptions {
  readonly onCommandStart?: () => void;
  readonly onCommandSettled?: () => void;
}

export function createCliCommandService(runtime: CliDaemonRuntime, options: CliCommandServiceOptions = {}): CliCommandService {
  return {
    runCommand: async (payload, context) => {
      options.onCommandStart?.();
      const command = readParsedCommandPayload(payload);
      const daemonActor = context?.actor;
      const sessionId = readSessionId(payload);
      try {
        const attribution = daemonActor ? daemonActorAttribution(daemonActor) : undefined;
        const result = await runRegisteredCommandWithCliComposition(command, {
          requireProvidedActorAttribution: true,
          ...(attribution ? { actorAttribution: attribution } : {
            missingActorAttributionMessage: "Daemon writes require a per-request authenticated actor from harness/people.yaml."
          }),
          makeWriteCoordinator: (actor) => attribution
            ? makeDaemonQueuedWriteCoordinator(
              runtime,
              `${command.action.kind}:${actor.kind}:${actor.id}`,
              { actor: attribution.actor, commitAuthor: attribution.commitAuthor, ...(sessionId ? { sessionId } : {}) }
            )
            : missingDaemonActorCoordinator(command.action.kind, actor)
        });
        return toCommandReceipt(result);
      } catch (error) {
        if (error instanceof CliActorAttributionError) {
          return toCommandReceipt({
            ok: false,
            command: command.action.kind,
            error: cliError(CliErrorCode.AuthMissing, error.message)
          });
        }
        throw error;
      } finally {
        options.onCommandSettled?.();
      }
    }
  };
}

function missingDaemonActorCoordinator(
  commandKind: string,
  requestedActor: { readonly kind: "agent" | "human" | "system"; readonly id: string }
): WriteCoordinator {
  const fail = () => Effect.fail({
    _tag: "JournalUnavailable" as const,
    cause: new Error(`Daemon command ${commandKind} requires a per-request authenticated actor from harness/people.yaml. Requested writer: ${requestedActor.kind}:${requestedActor.id}.`)
  });
  return {
    enqueue: () => fail(),
    flush: () => fail(),
    recover: fail()
  };
}

function readSessionId(payload: JsonObject | undefined): string | undefined {
  const session = payload?.session;
  if (!isPlainRecord(session) || typeof session.sessionId !== "string") return undefined;
  const trimmed = session.sessionId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readParsedCommandPayload(payload: JsonObject | undefined): ParsedCommand {
  const command = payload?.command;
  if (!isPlainRecord(command) || typeof command.rootDir !== "string" || !isPlainRecord(command.action) || typeof command.action.kind !== "string") {
    throw new Error("command.run requires payload.command parsed by the CLI parser.");
  }
  return command as unknown as ParsedCommand;
}

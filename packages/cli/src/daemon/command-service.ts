import { Effect } from "effect";
import type { AuthenticatedActor, JsonObject } from "../../../daemon/src/index.ts";
import { makeHumanFallbackSessionProbe, type TaskHolderExecutor } from "../../../application/src/index.ts";
import type { CurrentSessionRef, WriteCoordinator } from "../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import { toCommandReceipt, type CommandFailureReceipt, type CommandReceipt } from "../cli/receipt.ts";
import type { ParsedCommand } from "../cli/types.ts";
import { isPlainRecord } from "../cli/value-utils.ts";
import { CliActorAttributionError, daemonActorAttribution } from "../composition/actor-attribution.ts";
import { runRegisteredCommandWithCliComposition } from "../composition/command-executor.ts";
import { makeDaemonQueuedOperationalWriteCoordinator, makeDaemonQueuedWriteCoordinator, type CliDaemonRuntime } from "./queued-write-coordinator.ts";

export interface CliCommandService {
  readonly runCommand: (payload?: JsonObject, context?: { readonly actor?: AuthenticatedActor; readonly executor?: TaskHolderExecutor | null }) => Promise<CommandReceipt | CommandFailureReceipt>;
}

export interface CliCommandServiceOptions {
  readonly onCommandStart?: () => void;
  readonly onCommandSettled?: () => void;
}

export function createCliCommandService(runtime: CliDaemonRuntime, options: CliCommandServiceOptions = {}): CliCommandService {
  return {
    runCommand: async (payload, context) => {
      options.onCommandStart?.();
      let command: ParsedCommand | undefined;
      try {
        const parsedCommand = readParsedCommandPayload(payload);
        command = parsedCommand;
        const daemonActor = context?.actor;
        const currentSession = readCurrentSession(payload) ?? Effect.runSync(makeHumanFallbackSessionProbe().currentSession);
        const attribution = daemonActor ? daemonActorAttribution(daemonActor, context?.executor) : undefined;
        const result = await runRegisteredCommandWithCliComposition(parsedCommand, {
          requireProvidedActorAttribution: true,
          ...(attribution ? { actorAttribution: attribution } : {
            missingActorAttributionMessage: "Daemon writes require a per-request authenticated actor from harness/people.yaml."
          }),
          ...(currentSession ? { currentSession } : {}),
          makeWriteCoordinator: (actor) => attribution
            ? makeDaemonQueuedWriteCoordinator(
              runtime,
              `${parsedCommand.action.kind}:${actor.kind}:${actor.id}`,
              { attribution: attribution.writeAttribution, commitAuthor: attribution.commitAuthor }
            )
            : missingDaemonActorCoordinator(parsedCommand.action.kind, actor),
          makeOperationalWriteCoordinator: (actor) => makeDaemonQueuedOperationalWriteCoordinator(
            runtime,
            `${parsedCommand.action.kind}:${actor.kind}:${actor.id}:operational`,
            actor
          )
        });
        return toCommandReceipt(result);
      } catch (error) {
        if (error instanceof CurrentSessionPayloadError) {
          return toCommandReceipt({
            ok: false,
            command: command?.action.kind ?? "repo.command.run",
            error: cliError(CliErrorCode.InvalidSession, error.message)
          });
        }
        if (error instanceof CliActorAttributionError) {
          return toCommandReceipt({
            ok: false,
            command: command?.action.kind ?? "repo.command.run",
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

function readCurrentSession(payload: JsonObject | undefined): CurrentSessionRef | undefined {
  const session = payload?.session;
  if (session === undefined) return undefined;
  if (!isPlainRecord(session)) throw new CurrentSessionPayloadError("command.run payload.session must be a CurrentSessionRef object.");
  const runtime = session.runtime;
  const source = session.source;
  const validatedRuntime = isCurrentSessionRuntime(runtime) ? runtime : undefined;
  const validatedSource = source === "runtime" || source === "manual" ? source : undefined;
  const sessionId = typeof session.sessionId === "string" ? session.sessionId.trim() : "";
  const detectedAt = typeof session.detectedAt === "string" ? session.detectedAt.trim() : "";
  const issues: string[] = [];
  if (!validatedRuntime) issues.push("runtime");
  if (!validatedSource) issues.push("source");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(sessionId)) issues.push("sessionId");
  if (!detectedAt || Number.isNaN(Date.parse(detectedAt))) issues.push("detectedAt");
  if (session.user !== undefined && typeof session.user !== "string") issues.push("user");
  if (issues.length > 0) {
    throw new CurrentSessionPayloadError(`command.run payload.session has invalid fields: ${issues.join(", ")}.`);
  }
  return {
    runtime: validatedRuntime!,
    sessionId,
    source: validatedSource!,
    detectedAt,
    ...(typeof session.user === "string" && session.user.trim() ? { user: session.user.trim() } : {})
  };
}

class CurrentSessionPayloadError extends Error {}

function isCurrentSessionRuntime(value: unknown): value is CurrentSessionRef["runtime"] {
  return value === "human" || value === "claude-code" || value === "codex" || value === "zcode" || value === "antigravity";
}

function readParsedCommandPayload(payload: JsonObject | undefined): ParsedCommand {
  const command = payload?.command;
  if (!isPlainRecord(command) || typeof command.rootDir !== "string" || !isPlainRecord(command.action) || typeof command.action.kind !== "string") {
    throw new Error("command.run requires payload.command parsed by the CLI parser.");
  }
  return command as unknown as ParsedCommand;
}

import { Effect } from "effect";
import { commandClassForCliActionKind, type AuthenticatedActor, type JsonObject } from "../../../daemon/src/index.ts";
import { makeHumanFallbackSessionProbe, type ProvenanceSessionExporterRejected, type ProvenanceSessionExportResult, type TaskHolderExecutor } from "../../../application/src/index.ts";
import type { CurrentSessionRef, WriteCoordinator } from "../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import { toCommandReceipt, type CommandFailureReceipt, type CommandReceipt } from "../cli/receipt.ts";
import type { ParsedCommand } from "../cli/types.ts";
import { isPlainRecord } from "../cli/value-utils.ts";
import { CliActorAttributionError, daemonActorAttributionForParsedCommand, migrationWriteAttribution } from "../composition/actor-attribution.ts";
import { runRegisteredCommandWithCliComposition } from "../composition/command-executor.ts";
import { materializerCommandResult } from "../commands/core/materializer.ts";
import { makeDaemonAuthorityWriteCoordinator, type DaemonAuthorityCommandSubmissionV2 } from "./authority-command-submission.ts";
import { makeDaemonQueuedOperationalWriteCoordinator, makeDaemonQueuedWriteCoordinator, type CliDaemonRuntime } from "./queued-write-coordinator.ts";

export interface CliCommandService {
  readonly runCommand: (payload?: JsonObject, context?: { readonly actor?: AuthenticatedActor; readonly executor?: TaskHolderExecutor | null }) => Promise<CommandReceipt | CommandFailureReceipt>;
}

export interface CliCommandServiceOptions {
  readonly onCommandStart?: () => void;
  readonly onCommandSettled?: () => void;
  readonly authoritySubmissionV2?: DaemonAuthorityCommandSubmissionV2;
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
        if (parsedCommand.action.kind === "materializer-run") {
          const report = await runtime.enqueueMaterializerBatch({ dryRun: parsedCommand.action.dryRun });
          return toCommandReceipt(materializerCommandResult(report));
        }
        const attribution = daemonActor
          ? daemonActorAttributionForParsedCommand(daemonActor, parsedCommand, context?.executor)
          : undefined;
        const authorityCoordinator = attribution && options.authoritySubmissionV2
          ? makeDaemonAuthorityWriteCoordinator(options.authoritySubmissionV2, {
            command: parsedCommand,
            attribution,
            currentSession
          })
          : undefined;
        const result = await runRegisteredCommandWithCliComposition(parsedCommand, {
          requireProvidedActorAttribution: true,
          ...(attribution ? { actorAttribution: attribution } : {
            missingActorAttributionMessage: "Daemon writes require a per-request authenticated actor from harness/people.yaml."
          }),
          ...(currentSession ? { currentSession } : {}),
          syncExportedSession: (exported) => materializeExportedSessionEffect(runtime, exported),
          makeWriteCoordinator: (actor) => attribution
            ? authorityCoordinator
              ? authorityCoordinator
              : makeDaemonQueuedWriteCoordinator(
                runtime,
                `${parsedCommand.action.kind}:${actor.kind}:${actor.id}`,
                {
                  attribution: attribution.writeAttribution,
                  commitAuthor: attribution.commitAuthor,
                  ...(currentSession?.source === "runtime" ? { sessionId: currentSession.sessionId } : {})
                }
              )
            : missingDaemonActorCoordinator(parsedCommand.action.kind, actor),
          makeMigrationWriteCoordinator: (actor, evidenceRef) => attribution
            ? makeDaemonQueuedWriteCoordinator(
              runtime,
              `${parsedCommand.action.kind}:${actor.kind}:${actor.id}:migration`,
              {
                attribution: migrationWriteAttribution(attribution.writeAttribution, evidenceRef),
                commitAuthor: attribution.commitAuthor,
                ...(currentSession?.source === "runtime" ? { sessionId: currentSession.sessionId } : {})
              }
            )
            : missingDaemonActorCoordinator(parsedCommand.action.kind, actor),
          makeOperationalWriteCoordinator: (actor) => makeDaemonQueuedOperationalWriteCoordinator(
            runtime,
            `${parsedCommand.action.kind}:${actor.kind}:${actor.id}:operational`,
            actor
          )
        });
        return toCommandReceipt(await withSessionMaterialization(result, parsedCommand, currentSession, runtime));
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

export function materializeExportedSession(
  runtime: CliDaemonRuntime,
  exported: ProvenanceSessionExportResult
): Promise<void> {
  const sessionId = exported.session.sessionId;
  return (async () => {
    try {
      const report = await runtime.enqueueMaterializerBatch({ sessionId });
      const target = report.branches.find((branch) => branch.branch === `sessions/${sessionId}`);
      if (!target || target.commitCount === 0 || target.status === "merged") return;
      throw new Error(target.warning ?? `materializer left sessions/${sessionId} in ${target.status} state`);
    } catch (error) {
      throw sessionMaterializationRejection(sessionId, error);
    }
  })();
}

function materializeExportedSessionEffect(
  runtime: CliDaemonRuntime,
  exported: ProvenanceSessionExportResult
): Effect.Effect<void, ProvenanceSessionExporterRejected> {
  return Effect.tryPromise({
    try: () => materializeExportedSession(runtime, exported),
    catch: (error) => isSessionMaterializationRejection(error)
      ? error
      : sessionMaterializationRejection(exported.session.sessionId, error)
  });
}

function sessionMaterializationRejection(sessionId: string, error: unknown): ProvenanceSessionExporterRejected {
  return {
    _tag: "ProvenanceSessionExporterRejected",
    sessionId,
    code: "write_failed",
    reason: error instanceof Error ? error.message : String(error)
  };
}

function isSessionMaterializationRejection(error: unknown): error is ProvenanceSessionExporterRejected {
  return typeof error === "object" && error !== null && "_tag" in error
    && (error as { readonly _tag?: unknown })._tag === "ProvenanceSessionExporterRejected";
}

async function withSessionMaterialization(
  result: Awaited<ReturnType<typeof runRegisteredCommandWithCliComposition>>,
  command: ParsedCommand,
  currentSession: CurrentSessionRef,
  runtime: CliDaemonRuntime
): Promise<Awaited<ReturnType<typeof runRegisteredCommandWithCliComposition>>> {
  if (!result.ok || currentSession.source !== "runtime") return result;
  const commandClass = commandClassForCliActionKind(command.action.kind);
  if (commandClass !== "repo-write" && commandClass !== "arbiter") return result;

  try {
    const report = await runtime.enqueueMaterializerBatch({ sessionId: currentSession.sessionId });
    const target = report.branches.find((branch) => branch.branch === `sessions/${currentSession.sessionId}`);
    if (!target || target.commitCount === 0 || target.status === "merged") return result;
    return appendPendingMaterializationWarning(result, currentSession.sessionId, target.warning);
  } catch (error) {
    return appendPendingMaterializationWarning(
      result,
      currentSession.sessionId,
      error instanceof Error ? error.message : String(error)
    );
  }
}

function appendPendingMaterializationWarning(
  result: Awaited<ReturnType<typeof runRegisteredCommandWithCliComposition>>,
  sessionId: string,
  reason?: string
): Awaited<ReturnType<typeof runRegisteredCommandWithCliComposition>> {
  const nextCommand = "ha materializer run --json";
  return {
    ...result,
    warnings: [
      ...(result.warnings ?? []),
      {
        severity: "warning",
        code: "pending_materialization",
        message: `Write is durable on sessions/${sessionId} but is not yet visible on canonical read paths.${reason ? ` Cause: ${reason}` : ""} Run: ${nextCommand}`,
        sessionId,
        nextCommand
      }
    ]
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

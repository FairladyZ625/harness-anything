import { Effect } from "effect";
import {
  commandClassForCliActionKind
} from "../protocol/method-registry.ts";
import type { AuthenticatedActor } from "../identity/types.ts";
import type { AuthorityConnectionDispatch } from "../protocol/connection-context.ts";
import type { JsonObject } from "../protocol/json-rpc-types.ts";
import {
  makeHumanFallbackSessionProbe,
  type AuthorityCutoverCommandAction,
  type AuthorityCutoverControlService,
  type AuthorityHostCommand,
  type CommandReceiptEnvelope,
  type DaemonCommandHostServices,
  type DaemonHostCommand,
  type DaemonHostCommandResult,
  type ProvenanceSessionExporterRejected,
  type ProvenanceSessionExportResult,
  type TaskHolderExecutor
} from "@harness-anything/application";
import type { CurrentSessionRef, WriteCoordinator } from "@harness-anything/kernel";
import {
  isAuthorityCutoverAction,
  runAuthorityCutoverControlCommand
} from "../authority/authority-cutover-command.ts";
import {
  makeDaemonAuthorityWriteCoordinator,
  type DaemonAuthorityCommandSubmissionV2
} from "../authority/authority-command-submission.ts";
import {
  makeDaemonQueuedOperationalWriteCoordinator,
  makeDaemonQueuedWriteCoordinator,
  type CliDaemonRuntime
} from "../lifecycle/queued-write-coordinator.ts";

export interface DaemonCommandService {
  readonly runCommand: (payload?: JsonObject, context?: {
    readonly actor?: AuthenticatedActor;
    readonly executor?: TaskHolderExecutor | null;
    readonly authorityConnection?: AuthorityConnectionDispatch;
  }) => Promise<CommandReceiptEnvelope>;
}

export interface DaemonCommandServiceOptions {
  readonly onCommandStart?: () => void;
  readonly onCommandSettled?: () => void;
  readonly resolveAuthoritySubmissionV2?: (
    connection: AuthorityConnectionDispatch | undefined
  ) => DaemonAuthorityCommandSubmissionV2 | undefined;
  readonly authorityCutoverControl?: AuthorityCutoverControlService;
}

export function createDaemonCommandService<
  Command extends DaemonHostCommand,
  Result extends DaemonHostCommandResult
>(
  runtime: CliDaemonRuntime,
  hostServices: DaemonCommandHostServices<Command, Result, AuthenticatedActor>,
  options: DaemonCommandServiceOptions = {}
): DaemonCommandService {
  return {
    runCommand: async (payload, context) => {
      options.onCommandStart?.();
      let command: Command | undefined;
      try {
        const wireCommand = hostServices.parseCommandPayload(payload);
        const currentSession = readCurrentSession(payload) ?? Effect.runSync(makeHumanFallbackSessionProbe().currentSession);
        const parsedCommand = await hostServices.normalizeCommand(wireCommand, currentSession);
        command = parsedCommand;
        const daemonActor = context?.actor;
        if (isAuthorityCutoverAction(parsedCommand.action)) {
          return hostServices.toReceipt(await runAuthorityCutoverControlCommand({
            action: parsedCommand.action as AuthorityCutoverCommandAction,
            control: options.authorityCutoverControl,
            authenticated: daemonActor !== undefined
          }));
        }
        if (parsedCommand.action.kind === "materializer-run") {
          const report = await runtime.enqueueMaterializerBatch({ dryRun: parsedCommand.action.dryRun });
          return hostServices.toReceipt(hostServices.materializerCommandResult(report));
        }
        const attribution = daemonActor
          ? hostServices.actorAttribution(daemonActor, parsedCommand, context?.executor ?? null)
          : undefined;
        const commandClass = commandClassForCliActionKind(parsedCommand.action.kind);
        const authoritySubmissionV2 = attribution
          && (commandClass === "repo-write" || commandClass === "arbiter")
          ? options.resolveAuthoritySubmissionV2?.(context?.authorityConnection)
          : undefined;
        const productionAuthorityCommand = hostServices.authorityCommand(parsedCommand);
        const authorityCoordinator = attribution && authoritySubmissionV2 && productionAuthorityCommand
          ? makeDaemonAuthorityWriteCoordinator(authoritySubmissionV2, {
            command: productionAuthorityCommand,
            attribution,
            currentSession,
            ingressAdapter: hostServices.authorityIngressFor(parsedCommand.action.kind)
          })
          : undefined;
        const dryRun = hostServices.isDryRunAction(parsedCommand);
        const dryRunCoordinator = dryRun
          ? dryRunWriteBarrier()
          : undefined;
        const result = await hostServices.executeCommand(parsedCommand, {
          requireProvidedActorAttribution: true,
          ...(attribution ? { actorAttribution: attribution } : {
            missingActorAttributionMessage: "Daemon writes require a per-request authenticated actor from harness/people.yaml."
          }),
          ...(currentSession ? { currentSession } : {}),
          ...(authorityCoordinator ? { inlineCreateProvenanceOnly: true } : {}),
          syncExportedSession: dryRun
            ? () => Effect.void
            : (exported) => materializeExportedSessionEffect(runtime, exported),
          makeWriteCoordinator: (actor) => dryRunCoordinator ?? (attribution
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
            : missingDaemonActorCoordinator(parsedCommand.action.kind, actor)),
          makeMigrationWriteCoordinator: (actor, evidenceRef) => dryRunCoordinator ?? (attribution
            ? makeDaemonQueuedWriteCoordinator(
              runtime,
              `${parsedCommand.action.kind}:${actor.kind}:${actor.id}:migration`,
              {
                attribution: hostServices.migrationWriteAttribution(attribution.writeAttribution, evidenceRef),
                commitAuthor: attribution.commitAuthor,
                ...(currentSession?.source === "runtime" ? { sessionId: currentSession.sessionId } : {})
              }
            )
            : missingDaemonActorCoordinator(parsedCommand.action.kind, actor)),
          makeOperationalWriteCoordinator: (actor) => dryRunCoordinator ?? makeDaemonQueuedOperationalWriteCoordinator(
              runtime,
              `${parsedCommand.action.kind}:${actor.kind}:${actor.id}:operational`,
              actor
            )
        });
        return hostServices.toReceipt(await withSessionMaterialization(result, parsedCommand, currentSession, runtime, hostServices));
      } catch (error) {
        if (error instanceof CurrentSessionPayloadError) {
          return hostServices.toReceipt({
            ok: false,
            command: command?.action.kind ?? "repo.command.run",
            error: hostServices.invalidSessionError(error.message)
          });
        }
        if (hostServices.isActorAttributionError(error)) {
          return hostServices.toReceipt({
            ok: false,
            command: command?.action.kind ?? "repo.command.run",
            error: hostServices.authMissingError(error instanceof Error ? error.message : String(error))
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

async function withSessionMaterialization<Command extends DaemonHostCommand, Result extends DaemonHostCommandResult>(
  result: Result,
  command: Command,
  currentSession: CurrentSessionRef,
  runtime: CliDaemonRuntime,
  hostServices: DaemonCommandHostServices<Command, Result, AuthenticatedActor>
): Promise<Result> {
  if (!result.ok || hostServices.isDryRunAction(command) || currentSession.source !== "runtime") return result;
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

function appendPendingMaterializationWarning<Result extends DaemonHostCommandResult>(
  result: Result,
  sessionId: string,
  reason?: string
): Result {
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
  } as Result;
}

function dryRunWriteBarrier(): WriteCoordinator {
  let opCount = 0;
  return {
    enqueue: (operation) => Effect.sync(() => {
      opCount += 1;
      return { opId: operation.opId, entityId: operation.entityId, accepted: true as const };
    }),
    flush: (reason) => Effect.sync(() => {
      const report = { reason, opCount, committed: false as const };
      opCount = 0;
      return report;
    }),
    recover: Effect.succeed({ replayedOps: 0 })
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
  if (!isCommandPayloadRecord(session)) throw new CurrentSessionPayloadError("command.run payload.session must be a CurrentSessionRef object.");
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

function isCommandPayloadRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

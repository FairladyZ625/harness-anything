import { Effect } from "effect";
import {
  bindCreateProvenance,
  isTaskHolderError,
  makeDecisionWriteService,
  makeEnvironmentCurrentSessionProbe,
  makeFactWriteService,
  makeProvenanceSessionExporter,
  makeRuntimeEventLedgerService,
  makeTaskHolderService,
  taskHolderPrincipalFromJournalActor,
  type ProvenanceSessionExportResult
} from "../../../application/src/index.ts";
import type { WriteCoordinator, WriteError } from "../../../kernel/src/index.ts";
import { createHarnessRuntimeContext, findConflictMarkerWarnings } from "../../../kernel/src/index.ts";
import { toCliError } from "../cli/error-mapper.ts";
import { actionTaskId } from "../cli/parse-args.ts";
import { requiresConflictMarkerPreflight, runRegisteredCommand } from "../cli/runner-registry.ts";
import type { CliResult, ParsedCommand } from "../cli/types.ts";
import { CliActorAttributionError, resolveLocalCliActorAttribution, type CliActorAttribution } from "./actor-attribution.ts";
import {
  defaultCliAdapterProvider,
  type CliCompositionAdapterProvider
} from "./adapter-registry.ts";

export interface ParsedCommandExecutionOptions {
  readonly provider?: CliCompositionAdapterProvider;
  readonly makeWriteCoordinator?: (actor: { readonly kind: "agent" | "human" | "system"; readonly id: string }) => WriteCoordinator;
  readonly actorAttribution?: CliActorAttribution;
  readonly missingActorAttributionMessage?: string;
  readonly requireProvidedActorAttribution?: boolean;
}

export async function runRegisteredCommandWithCliComposition(
  command: ParsedCommand,
  options: ParsedCommandExecutionOptions = {}
): Promise<CliResult> {
  const provider = options.provider ?? defaultCliAdapterProvider();
  const layoutInput = {
    rootDir: command.rootDir,
    layoutOverrides: command.layoutOverrides
  };
  let currentSessionProbe: ReturnType<typeof makeEnvironmentCurrentSessionProbe> | undefined;
  const getCurrentSessionProbe = () => {
    currentSessionProbe ??= makeEnvironmentCurrentSessionProbe();
    return currentSessionProbe;
  };
  let sessionBranchResolved = false;
  let sessionBranchId: string | undefined;
  const getSessionBranchId = () => {
    if (!sessionBranchResolved) {
      const session = Effect.runSync(getCurrentSessionProbe().currentSession);
      sessionBranchId = session.source === "runtime" ? session.sessionId : undefined;
      sessionBranchResolved = true;
    }
    return sessionBranchId;
  };
  const syncExportedSession = (_result: ProvenanceSessionExportResult): Effect.Effect<void, never> => Effect.void;
  let actorAttributionResolved = false;
  let actorAttribution: CliActorAttribution | undefined;
  let actorAttributionError: CliActorAttributionError | undefined;
  const getActorAttribution = () => {
    if (!actorAttributionResolved) {
      actorAttributionResolved = true;
      try {
        if (options.actorAttribution) {
          actorAttribution = options.actorAttribution;
        } else if (options.requireProvidedActorAttribution) {
          throw new CliActorAttributionError(options.missingActorAttributionMessage ?? "Actor attribution is required.");
        } else {
          actorAttribution = resolveLocalCliActorAttribution();
        }
      } catch (error) {
        actorAttributionError = error instanceof CliActorAttributionError
          ? error
          : new CliActorAttributionError(error instanceof Error ? error.message : String(error));
      }
    }
    if (actorAttributionError) throw actorAttributionError;
    return actorAttribution!;
  };

  const rawMakeWriteCoordinator = options.makeWriteCoordinator ?? ((actor: { readonly kind: "agent" | "human" | "system"; readonly id: string }) =>
    makeAttributedWriteCoordinator(() => provider.createWriteCoordinator({
      rootDir: command.rootDir,
      layoutOverrides: command.layoutOverrides,
      actor: getActorAttribution().actor,
      commitAuthor: getActorAttribution().commitAuthor,
      sessionId: getSessionBranchId()
    }), getActorAttribution, options.missingActorAttributionMessage, actor));
  const makeWriteCoordinator = requiresConflictMarkerPreflight(command.action)
    ? (actor: { readonly kind: "agent" | "human" | "system"; readonly id: string }) => withConflictMarkerFlushRecheck(rawMakeWriteCoordinator(actor), layoutInput)
    : rawMakeWriteCoordinator;
  const rawMakeSessionWriteCoordinator = options.makeWriteCoordinator ?? ((actor: { readonly kind: "agent" | "human" | "system"; readonly id: string }) =>
    makeAttributedWriteCoordinator(() => provider.createWriteCoordinator({
      rootDir: command.rootDir,
      layoutOverrides: command.layoutOverrides,
      actor: getActorAttribution().actor,
      commitAuthor: getActorAttribution().commitAuthor
    }), getActorAttribution, options.missingActorAttributionMessage, actor));
  const makeSessionWriteCoordinator = requiresConflictMarkerPreflight(command.action)
    ? (actor: { readonly kind: "agent" | "human" | "system"; readonly id: string }) => withConflictMarkerFlushRecheck(rawMakeSessionWriteCoordinator(actor), layoutInput)
    : rawMakeSessionWriteCoordinator;

  const makeArtifactStore = () => provider.createArtifactStore({
    rootDir: command.rootDir,
    layoutOverrides: command.layoutOverrides
  });
  const makeTaskHolder = () => makeTaskHolderService({ rootInput: layoutInput });
  const makeSessionExporter = () => makeProvenanceSessionExporter({
    rootInput: layoutInput,
    currentSessionProbe: getCurrentSessionProbe(),
    coordinator: makeSessionWriteCoordinator({ kind: "agent", id: "session-export" }),
    artifactStore: makeArtifactStore()
  });

  return Effect.runPromise(runRegisteredCommand(command, () => withOptionalLeaseGuard(provider.createLifecycleEngine({
    rootDir: command.rootDir,
    layoutOverrides: command.layoutOverrides,
    coordinator: makeWriteCoordinator({ kind: "agent", id: "task-lifecycle" }),
    bindCreateProvenance: (boundAt) => bindCreateProvenance({
      currentSessionProbe: getCurrentSessionProbe(),
      provenanceSessionExporter: makeSessionExporter(),
      syncExportedSession
    }, boundAt)
  }), makeTaskHolder, getActorAttribution), makeArtifactStore, getCurrentSessionProbe, makeSessionExporter, syncExportedSession, makeWriteCoordinator, getActorAttribution, () => makeDecisionWriteService({
    rootInput: layoutInput,
    coordinator: makeWriteCoordinator({ kind: "agent", id: "decision-cli" }),
    currentSessionProbe: getCurrentSessionProbe(),
    provenanceSessionExporter: makeSessionExporter(),
    syncExportedSession
  }), () => withOptionalFactLeaseGuard(makeFactWriteService({
    rootInput: layoutInput,
    coordinator: makeWriteCoordinator({ kind: "agent", id: "fact-cli" }),
    currentSessionProbe: getCurrentSessionProbe(),
    provenanceSessionExporter: makeSessionExporter(),
    syncExportedSession
  }), makeTaskHolder, getActorAttribution), makeTaskHolder, () => makeRuntimeEventLedgerService({
    rootInput: layoutInput,
    coordinator: makeWriteCoordinator({ kind: "agent", id: "runtime-event-cli" })
  }), provider.runLedgerMaterializer).pipe(
    Effect.match({
      onFailure: (error): CliResult => ({
        ok: false,
        command: command.action.kind,
        taskId: actionTaskId(command.action),
        error: toCliError(error)
      }),
      onSuccess: (value) => value
    })
  ));
}

export function commandRootInput(command: ParsedCommand): ReturnType<typeof createHarnessRuntimeContext> {
  return createHarnessRuntimeContext(command.rootDir, command.layoutOverrides);
}

type LifecycleEngine = ReturnType<CliCompositionAdapterProvider["createLifecycleEngine"]>;
type FactWriteService = ReturnType<typeof makeFactWriteService>;
type TaskHolderServiceFactory = () => ReturnType<typeof makeTaskHolderService>;
type ActorAttributionFactory = () => CliActorAttribution;

function withOptionalLeaseGuard(
  engine: LifecycleEngine,
  makeTaskHolder: TaskHolderServiceFactory,
  getActorAttribution: ActorAttributionFactory
): LifecycleEngine {
  if (!leaseEnforcementEnabled()) return engine;
  const guard = (taskId: string) => assertTaskLease(taskId, makeTaskHolder, getActorAttribution);
  return {
    ...engine,
    setStatus: (input) => guard(input.taskId).pipe(Effect.flatMap(() => engine.setStatus(input))),
    appendProgress: (input) => guard(input.taskId).pipe(Effect.flatMap(() => engine.appendProgress(input))),
    archiveTask: (input) => guard(input.taskId).pipe(Effect.flatMap(() => engine.archiveTask(input))),
    supersedeTask: (input) => guard(input.oldTaskId).pipe(Effect.flatMap(() => engine.supersedeTask(input))),
    deleteTask: (input) => guard(input.taskId).pipe(Effect.flatMap(() => engine.deleteTask(input))),
    reopenTask: (input) => guard(input.taskId).pipe(Effect.flatMap(() => engine.reopenTask(input)))
  };
}

function withOptionalFactLeaseGuard(
  service: FactWriteService,
  makeTaskHolder: TaskHolderServiceFactory,
  getActorAttribution: ActorAttributionFactory
): FactWriteService {
  if (!leaseEnforcementEnabled()) return service;
  const guard = (taskId: string) => assertTaskLease(taskId, makeTaskHolder, getActorAttribution);
  return {
    ...service,
    record: (request) => guard(request.ownerTaskId).pipe(Effect.flatMap(() => service.record(request))),
    invalidate: (request) => guard(request.ownerTaskId).pipe(Effect.flatMap(() => service.invalidate(request)))
  };
}

function assertTaskLease(
  taskId: string,
  makeTaskHolder: TaskHolderServiceFactory,
  getActorAttribution: ActorAttributionFactory
): Effect.Effect<void, WriteError> {
  return Effect.tryPromise({
    try: () => makeTaskHolder().assertActiveLease({
      taskId,
      principal: taskHolderPrincipalFromJournalActor(getActorAttribution().actor)
    }),
    catch: taskLeaseWriteError
  });
}

function taskLeaseWriteError(error: unknown): WriteError {
  if (isTaskHolderError(error)) {
    return {
      _tag: "WriteRejected",
      taskId: error.taskId,
      reason: error.message,
      code: error.code,
      retryable: false
    };
  }
  return { _tag: "JournalUnavailable", cause: error };
}

function leaseEnforcementEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.HARNESS_TASK_LEASE_ENFORCEMENT?.trim().toLowerCase();
  return value === "1" || value === "true";
}

function withConflictMarkerFlushRecheck(
  coordinator: WriteCoordinator,
  rootInput: ReturnType<typeof createHarnessRuntimeContext>
): WriteCoordinator {
  return {
    enqueue: coordinator.enqueue,
    recover: coordinator.recover,
    flush: (reason) => Effect.try({
      try: () => findConflictMarkerWarnings(rootInput)[0],
      catch: (cause) => ({ _tag: "JournalUnavailable" as const, cause })
    }).pipe(
      Effect.flatMap((warning) => warning
        ? Effect.fail({
          _tag: "WriteRejected" as const,
          taskId: "preflight",
          reason: warning.message
        })
        : coordinator.flush(reason))
    )
  };
}

function makeAttributedWriteCoordinator(
  create: () => WriteCoordinator,
  getActorAttribution: () => CliActorAttribution,
  missingMessage: string | undefined,
  requestedActor: { readonly kind: "agent" | "human" | "system"; readonly id: string }
): WriteCoordinator {
  try {
    getActorAttribution();
    return create();
  } catch (error) {
    const message = missingMessage ?? (error instanceof Error ? error.message : String(error));
    return failingWriteCoordinator(message, requestedActor);
  }
}

function failingWriteCoordinator(
  message: string,
  requestedActor: { readonly kind: "agent" | "human" | "system"; readonly id: string }
): WriteCoordinator {
  const fail = () => Effect.fail({
    _tag: "JournalUnavailable" as const,
    cause: new Error(`${message} Requested writer: ${requestedActor.kind}:${requestedActor.id}.`)
  });
  return {
    enqueue: () => fail(),
    flush: () => fail(),
    recover: fail()
  };
}

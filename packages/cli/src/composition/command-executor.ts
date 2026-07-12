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
  type ProvenanceSessionExportResult,
  type TaskHolderPrincipal
} from "../../../application/src/index.ts";
import type { OperationalActor, WriteCoordinator, WriteError } from "../../../kernel/src/index.ts";
import { createHarnessRuntimeContext, findConflictMarkerWarnings } from "../../../kernel/src/index.ts";
import { toCliError } from "../cli/error-mapper.ts";
import { actionTaskId } from "../cli/parse-args.ts";
import { requiresConflictMarkerPreflight, runRegisteredCommand } from "../cli/runner-registry.ts";
import type { CliResult, ParsedCommand } from "../cli/types.ts";
import { leaseEnforcementEnabled } from "../commands/settings.ts";
import { CliActorAttributionError, type CliActorAttribution } from "./actor-attribution.ts";
import { CliPrincipalResolutionError, resolveCliTaskHolderPrincipal, resolveLocalCliActorAttribution } from "./local-principal.ts";
import {
  defaultCliAdapterProvider,
  type CliCompositionAdapterProvider
} from "./adapter-registry.ts";

export interface ParsedCommandExecutionOptions {
  readonly provider?: CliCompositionAdapterProvider;
  readonly makeWriteCoordinator?: (actor: OperationalActor) => WriteCoordinator;
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
  let enforceTaskLeaseResolved = false;
  let enforceTaskLeaseValue = false;
  const enforceTaskLease = () => {
    if (!enforceTaskLeaseResolved) {
      enforceTaskLeaseValue = leaseEnforcementEnabled(layoutInput);
      enforceTaskLeaseResolved = true;
    }
    return enforceTaskLeaseValue;
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
          actorAttribution = resolveLocalCliActorAttribution(layoutInput, process.env, command.actor);
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
  let taskHolderPrincipal: TaskHolderPrincipal | undefined;
  const getTaskHolderPrincipal = () => {
    taskHolderPrincipal ??= resolveCliTaskHolderPrincipal(layoutInput, getActorAttribution());
    return taskHolderPrincipal;
  };

  const rawMakeWriteCoordinator = options.makeWriteCoordinator ?? ((actor: OperationalActor) =>
    makeAttributedWriteCoordinator(() => provider.createWriteCoordinator({
      rootDir: command.rootDir,
      layoutOverrides: command.layoutOverrides,
      attribution: getActorAttribution().writeAttribution,
      commitAuthor: getActorAttribution().commitAuthor,
      sessionId: getSessionBranchId()
    }), getActorAttribution, options.missingActorAttributionMessage, actor));
  const makeWriteCoordinator = requiresConflictMarkerPreflight(command.action)
    ? (actor: OperationalActor) => withConflictMarkerFlushRecheck(rawMakeWriteCoordinator(actor), layoutInput)
    : rawMakeWriteCoordinator;
  const rawMakeSessionWriteCoordinator = options.makeWriteCoordinator ?? ((actor: OperationalActor) =>
    makeAttributedWriteCoordinator(() => provider.createWriteCoordinator({
      rootDir: command.rootDir,
      layoutOverrides: command.layoutOverrides,
      attribution: getActorAttribution().writeAttribution,
      commitAuthor: getActorAttribution().commitAuthor
    }), getActorAttribution, options.missingActorAttributionMessage, actor));
  const makeSessionWriteCoordinator = requiresConflictMarkerPreflight(command.action)
    ? (actor: OperationalActor) => withConflictMarkerFlushRecheck(rawMakeSessionWriteCoordinator(actor), layoutInput)
    : rawMakeSessionWriteCoordinator;

  const makeArtifactStore = () => provider.createArtifactStore({
    rootDir: command.rootDir,
    layoutOverrides: command.layoutOverrides
  });
  const makeTaskHolder = () => makeTaskHolderService({ rootInput: layoutInput });
  const makeSessionExporter = () => makeProvenanceSessionExporter({
    rootInput: layoutInput,
    currentSessionProbe: getCurrentSessionProbe(),
    coordinator: makeSessionWriteCoordinator(operationalActor("session-export")),
    artifactStore: makeArtifactStore()
  });

  return Effect.runPromise(runRegisteredCommand(command, () => withOptionalLeaseGuard(provider.createLifecycleEngine({
    rootDir: command.rootDir,
    layoutOverrides: command.layoutOverrides,
    coordinator: makeWriteCoordinator(operationalActor("task-lifecycle")),
    bindCreateProvenance: (boundAt) => bindCreateProvenance({
      currentSessionProbe: getCurrentSessionProbe(),
      provenanceSessionExporter: makeSessionExporter(),
      syncExportedSession
    }, boundAt)
  }), enforceTaskLease(), makeTaskHolder, getTaskHolderPrincipal), makeArtifactStore, getCurrentSessionProbe, makeSessionExporter, syncExportedSession, makeWriteCoordinator, getActorAttribution, getTaskHolderPrincipal, () => makeDecisionWriteService({
    rootInput: layoutInput,
    coordinator: makeWriteCoordinator(operationalActor("decision-cli")),
    currentSessionProbe: getCurrentSessionProbe(),
    provenanceSessionExporter: makeSessionExporter(),
    syncExportedSession
  }), () => withOptionalFactLeaseGuard(makeFactWriteService({
    rootInput: layoutInput,
    coordinator: makeWriteCoordinator(operationalActor("fact-cli")),
    currentSessionProbe: getCurrentSessionProbe(),
    provenanceSessionExporter: makeSessionExporter(),
    syncExportedSession
  }), enforceTaskLease(), makeTaskHolder, getTaskHolderPrincipal), makeTaskHolder, () => makeRuntimeEventLedgerService({
    rootInput: layoutInput,
    coordinator: makeWriteCoordinator(operationalActor("runtime-event-cli"))
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
type TaskHolderPrincipalFactory = () => TaskHolderPrincipal;

function withOptionalLeaseGuard(
  engine: LifecycleEngine,
  enabled: boolean,
  makeTaskHolder: TaskHolderServiceFactory,
  getTaskHolderPrincipal: TaskHolderPrincipalFactory
): LifecycleEngine {
  if (!enabled) return engine;
  const guard = (taskId: string) => assertTaskLease(taskId, makeTaskHolder, getTaskHolderPrincipal);
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
  enabled: boolean,
  makeTaskHolder: TaskHolderServiceFactory,
  getTaskHolderPrincipal: TaskHolderPrincipalFactory
): FactWriteService {
  if (!enabled) return service;
  const guard = (taskId: string) => assertTaskLease(taskId, makeTaskHolder, getTaskHolderPrincipal);
  return {
    ...service,
    record: (request) => guard(request.ownerTaskId).pipe(Effect.flatMap(() => service.record(request))),
    invalidate: (request) => guard(request.ownerTaskId).pipe(Effect.flatMap(() => service.invalidate(request)))
  };
}

function assertTaskLease(
  taskId: string,
  makeTaskHolder: TaskHolderServiceFactory,
  getTaskHolderPrincipal: TaskHolderPrincipalFactory
): Effect.Effect<void, WriteError> {
  return Effect.tryPromise({
    try: () => makeTaskHolder().assertActiveLease({
      taskId,
      principal: getTaskHolderPrincipal()
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
  if (error instanceof CliPrincipalResolutionError || error instanceof CliActorAttributionError) {
    return {
      _tag: "WriteRejected",
      reason: error.message,
      code: "identity_required",
      retryable: false
    };
  }
  return { _tag: "JournalUnavailable", cause: error };
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
  requestedActor: OperationalActor
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
  requestedActor: OperationalActor
): WriteCoordinator {
  const fail = () => Effect.fail({
    _tag: "WriteRejected" as const,
    reason: `${message} Requested writer: ${requestedActor.kind}:${requestedActor.id}.`,
    code: "identity_required",
    retryable: false
  });
  return {
    enqueue: () => fail(),
    flush: () => fail(),
    recover: fail()
  };
}

function operationalActor(id: string): OperationalActor {
  return { scope: "operational", kind: "agent", id };
}

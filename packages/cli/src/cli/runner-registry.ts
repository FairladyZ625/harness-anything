import { Effect } from "effect";
import type { DecisionWriteService, FactWriteService, ProvenanceSessionExporter, ProvenanceSessionExporterRejected, ProvenanceSessionExportResult, RuntimeEventLedgerService, TaskHolderPrincipal, TaskHolderService } from "../../../application/src/index.ts";
import type { ArtifactStore, CurrentSessionProbePort, OperationalActor } from "../../../kernel/src/index.ts";
import type { ArtifactStoreError, DomainStatus, EngineError, PriorityTier, TaskWorkKind, WriteError } from "../../../kernel/src/index.ts";
import type { HarnessLayoutInput, HarnessLayoutOverrides } from "../../../kernel/src/index.ts";
import { createHarnessRuntimeContext } from "../../../kernel/src/index.ts";
import type { WriteCoordinator } from "../../../kernel/src/index.ts";
import { requiresConflictMarkerPreflight, taskPrincipalRequiredForAction } from "./command-event-policy.ts";
import { commandSpecMap, commandSpecs, type CommandKind } from "./command-spec/index.ts";
import type { CommandSpecDefinition } from "./command-spec/types.ts";
import { commandDescriptors, commandRegistry } from "./command-registry.ts";
import type { CommandDescriptor } from "./command-registry.ts";
import { readConflictMarkerPreflight } from "./conflict-preflight.ts";
import { cliError, CliErrorCode } from "./error-codes.ts";
import { toCliError } from "./error-mapper.ts";
import { actionTaskId } from "./parse-args.ts";
import { appendCommandRuntimeEvent } from "./command-runtime-events.ts";
import type { CliResult, CommandRegistryEntry, MaterializerCommandReport, ParsedCommand } from "./types.ts";
import type { CliActorAttribution } from "../composition/actor-attribution.ts";

export interface CommandRunnerContext {
  readonly rootDir: string;
  readonly layoutInput: HarnessLayoutInput;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly commandSpecs: ReadonlyArray<Pick<CommandSpecDefinition, "kind" | "eventPolicy">>;
  readonly commandDescriptors: ReadonlyArray<CommandDescriptor>;
  readonly commandRegistry: ReadonlyArray<CommandRegistryEntry>;
  readonly engine: CommandRunnerEngine;
  readonly artifactStore: Pick<ArtifactStore, "readTaskPackage" | "readAuthoredDocument">;
  readonly currentSessionProbe: CurrentSessionProbePort;
  readonly provenanceSessionExporter: ProvenanceSessionExporter;
  readonly syncExportedSession: (result: ProvenanceSessionExportResult) => Effect.Effect<void, ProvenanceSessionExporterRejected>;
  readonly runtimeEventLedgerService: RuntimeEventLedgerService;
  readonly makeWriteCoordinator: (actor: OperationalActor) => WriteCoordinator;
  readonly actorAttribution: () => CliActorAttribution;
  readonly taskHolderPrincipal: () => TaskHolderPrincipal;
  readonly decisionWriteService: DecisionWriteService;
  readonly factWriteService: FactWriteService;
  readonly taskHolderService: TaskHolderService;
  readonly runLedgerMaterializer: (options: { readonly dryRun?: boolean }) => MaterializerCommandReport;
}

export type CommandRunnerEffect = Effect.Effect<CliResult, ArtifactStoreError | EngineError | WriteError>;

type EngineEffect<A> = Effect.Effect<A, EngineError | WriteError>;

export interface CommandRunnerEngine {
  readonly createTask: (input: {
	    readonly taskId: string;
	    readonly title: string;
	    readonly parent?: string;
	    readonly workKind?: TaskWorkKind;
	    readonly riskTier?: PriorityTier;
	    readonly urgency?: PriorityTier;
	    readonly slug: string;
    readonly allowManualId: boolean;
  }) => EngineEffect<{ readonly taskId: string; readonly status: DomainStatus }>;
  readonly setStatus: (input: {
    readonly taskId: string;
    readonly status: DomainStatus;
  }) => EngineEffect<{ readonly taskId: string; readonly status: DomainStatus }>;
  readonly appendProgress: (input: {
    readonly taskId: string;
    readonly text: string;
  }) => EngineEffect<{ readonly taskId: string; readonly path: string }>;
  readonly stageDocument: (input: { readonly taskId: string; readonly path: string }) => EngineEffect<{ readonly taskId: string; readonly path: string }>;
  readonly stageTaskTree: (input: { readonly taskId: string }) => EngineEffect<{ readonly taskId: string; readonly path: string }>;
  readonly taskTreeStatus: (input: { readonly taskId: string }) => EngineEffect<{ readonly taskId: string; readonly dirty: boolean; readonly entries: ReadonlyArray<string> }>;
  readonly replaceTaskDocument: (input: {
    readonly taskId: string;
    readonly path: string;
    readonly body: string;
  }) => EngineEffect<{ readonly taskId: string; readonly path: string }>;
  readonly writeCodeDocReconciliation: (input: {
    readonly taskId: string;
    readonly body: string;
  }) => EngineEffect<{ readonly taskId: string; readonly path: string }>;
  readonly archiveTask: (input: {
    readonly taskId: string;
    readonly reason: string;
  }) => EngineEffect<{ readonly taskId: string; readonly status: DomainStatus }>;
  readonly supersedeTask: (input: {
    readonly oldTaskId: string;
    readonly newTaskId: string;
    readonly title: string;
    readonly slug: string;
    readonly reason: string;
    readonly scaffoldDocuments?: ReadonlyArray<{ readonly path: string; readonly body: string }>;
  }) => EngineEffect<{ readonly oldTaskId: string; readonly newTaskId: string }>;
  readonly deleteTask: (input: {
    readonly taskId: string;
    readonly mode: "soft" | "hard";
    readonly reason: string;
  }) => EngineEffect<{ readonly taskId: string; readonly mode: "soft" | "hard" }>;
  readonly reopenTask: (input: {
    readonly taskId: string;
    readonly reason: string;
  }) => EngineEffect<{ readonly taskId: string; readonly status: DomainStatus }>;
}

export type CommandRunner = (
  context: CommandRunnerContext,
  command: ParsedCommand
) => CommandRunnerEffect;

export const runnerRegistry = commandSpecMap((spec) => spec.run) satisfies Record<CommandKind, CommandRunner>;

export function runRegisteredCommand(
  command: ParsedCommand,
  makeEngine: () => CommandRunnerEngine,
  makeArtifactStore: () => Pick<ArtifactStore, "readTaskPackage" | "readAuthoredDocument">,
  makeCurrentSessionProbe: () => CurrentSessionProbePort,
  makeProvenanceSessionExporter: () => ProvenanceSessionExporter,
  syncExportedSession: (result: ProvenanceSessionExportResult) => Effect.Effect<void, ProvenanceSessionExporterRejected>,
  makeWriteCoordinator: (actor: OperationalActor) => WriteCoordinator,
  actorAttribution: () => CliActorAttribution,
  taskHolderPrincipal: () => TaskHolderPrincipal,
  makeDecisionWriteService: () => DecisionWriteService,
  makeFactWriteService: () => FactWriteService,
  makeTaskHolderService: () => TaskHolderService,
  makeRuntimeEventLedgerService: () => RuntimeEventLedgerService,
  runLedgerMaterializer: (rootInput: HarnessLayoutInput, options: { readonly dryRun?: boolean }) => MaterializerCommandReport
): CommandRunnerEffect {
  const runner = runnerRegistry[command.action.kind];
  const layoutInput = createHarnessRuntimeContext(command.rootDir, command.layoutOverrides);
  const conflictMarkerResult = requiresConflictMarkerPreflight(command.action) ? readConflictMarkerPreflight(command.action.kind, layoutInput) : undefined;
  if (conflictMarkerResult?.ok === false) return Effect.succeed(conflictMarkerResult.result);
  const conflictMarkerWarning = conflictMarkerResult?.warning;
  if (conflictMarkerWarning) {
    return Effect.succeed({
      ok: false,
      command: command.action.kind,
      warnings: [conflictMarkerWarning],
      error: cliError(CliErrorCode.ConflictMarkerPresent, conflictMarkerWarning.message)
    } satisfies CliResult);
  }
  let engine: CommandRunnerEngine | undefined;
  let artifactStore: Pick<ArtifactStore, "readTaskPackage" | "readAuthoredDocument"> | undefined;
  let currentSessionProbe: CurrentSessionProbePort | undefined;
  let provenanceSessionExporter: ProvenanceSessionExporter | undefined;
  let decisionWriteService: DecisionWriteService | undefined;
  let factWriteService: FactWriteService | undefined;
  let taskHolderService: TaskHolderService | undefined;
  let runtimeEventLedgerService: RuntimeEventLedgerService | undefined;
  const context: CommandRunnerContext = {
    rootDir: command.rootDir,
    layoutInput,
    layoutOverrides: command.layoutOverrides,
    commandSpecs,
    commandDescriptors,
    commandRegistry,
    get engine() {
      engine ??= makeEngine();
      return engine;
    },
    get artifactStore() {
      artifactStore ??= makeArtifactStore();
      return artifactStore;
    },
    get currentSessionProbe() {
      currentSessionProbe ??= makeCurrentSessionProbe();
      return currentSessionProbe;
    },
    get provenanceSessionExporter() {
      provenanceSessionExporter ??= makeProvenanceSessionExporter();
      return provenanceSessionExporter;
    },
    syncExportedSession,
    makeWriteCoordinator,
    actorAttribution,
    taskHolderPrincipal,
    get decisionWriteService() {
      decisionWriteService ??= makeDecisionWriteService();
      return decisionWriteService;
    },
    get factWriteService() {
      factWriteService ??= makeFactWriteService();
      return factWriteService;
    },
    get taskHolderService() {
      taskHolderService ??= makeTaskHolderService();
      return taskHolderService;
    },
    get runtimeEventLedgerService() {
      runtimeEventLedgerService ??= makeRuntimeEventLedgerService();
      return runtimeEventLedgerService;
    },
    runLedgerMaterializer: (options) => runLedgerMaterializer(layoutInput, options)
  };
  if (taskPrincipalRequiredForAction(command.action)) {
    try {
      context.taskHolderPrincipal();
    } catch (error) {
      return Effect.succeed({
        ok: false,
        command: command.action.kind,
        taskId: actionTaskId(command.action),
        error: cliError(CliErrorCode.AuthMissing, error instanceof Error ? error.message : String(error))
      } satisfies CliResult);
    }
  }
  return runner(context, command).pipe(
    Effect.catchAll((error) => Effect.succeed({
      ok: false,
      command: command.action.kind,
      taskId: actionTaskId(command.action),
      error: toCliError(error)
    } satisfies CliResult)),
    Effect.flatMap((result) => appendCommandRuntimeEvent(context, command, result))
  );
}

export { requiresConflictMarkerPreflight };

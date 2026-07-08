import { Effect } from "effect";
import type { DecisionWriteService, FactWriteService, ProvenanceSessionExporter, ProvenanceSessionExporterRejected, ProvenanceSessionExportResult, RuntimeEventLedgerService } from "../../../application/src/index.ts";
import type { ArtifactStore, CurrentSessionProbePort } from "../../../kernel/src/index.ts";
import type { ArtifactStoreError, DomainStatus, EngineError, PriorityTier, TaskWorkKind, WriteError } from "../../../kernel/src/index.ts";
import type { HarnessLayoutInput, HarnessLayoutOverrides } from "../../../kernel/src/index.ts";
import { createHarnessRuntimeContext } from "../../../kernel/src/index.ts";
import type { WriteCoordinator } from "../../../kernel/src/index.ts";
import { requiresConflictMarkerPreflight } from "./command-event-policy.ts";
import type { CommandRunnerId } from "./command-registry.ts";
import { runnerIdForAction } from "./command-registry.ts";
import { readConflictMarkerPreflight } from "./conflict-preflight.ts";
import { cliError, CliErrorCode } from "./error-codes.ts";
import { toCliError } from "./error-mapper.ts";
import { actionTaskId } from "./parse-args.ts";
import { appendCommandRuntimeEvent } from "./command-runtime-events.ts";
import type { CliResult, MaterializerCommandReport, ParsedCommand } from "./types.ts";
import type { CliActorAttribution } from "../composition/actor-attribution.ts";
import {
  runDiagnosticsCommand,
  runCapabilitiesCommand,
  runDecisionCommand,
  runDistillCommand,
  runDocCommand,
  runExtensionRunnerCommand,
  runFactCommand,
  runGovernanceCommand,
  runGuiCommand,
  runHelpCommand,
  runInitCommand,
  runMaterializerCommand,
  runMigrationCommand,
  runNewTaskCommand,
  runRuntimeEventCommand,
  runSessionCommand,
  runTaskGatesCommand,
  runTaskLifecycleCommand,
  runTaskQueryCommand,
  runVersionCommand,
  runWorktreeCommand
} from "../commands/core/index.ts";

export interface CommandRunnerContext {
  readonly rootDir: string;
  readonly layoutInput: HarnessLayoutInput;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly engine: CommandRunnerEngine;
  readonly artifactStore: Pick<ArtifactStore, "readTaskPackage" | "readAuthoredDocument">;
  readonly currentSessionProbe: CurrentSessionProbePort;
  readonly provenanceSessionExporter: ProvenanceSessionExporter;
  readonly syncExportedSession: (result: ProvenanceSessionExportResult) => Effect.Effect<void, ProvenanceSessionExporterRejected>;
  readonly runtimeEventLedgerService: RuntimeEventLedgerService;
  readonly makeWriteCoordinator: (actor: { readonly kind: "agent" | "human" | "system"; readonly id: string }) => WriteCoordinator;
  readonly actorAttribution: () => CliActorAttribution;
  readonly decisionWriteService: DecisionWriteService;
  readonly factWriteService: FactWriteService;
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

export const runnerRegistry = {
  help: runHelpCommand,
  capabilities: runCapabilitiesCommand,
  version: runVersionCommand,
  init: runInitCommand,
  "new-task": runNewTaskCommand,
  decision: runDecisionCommand,
  distill: runDistillCommand,
  fact: runFactCommand,
  "runtime-event": runRuntimeEventCommand,
  materializer: runMaterializerCommand,
  session: runSessionCommand,
  doc: runDocCommand,
  "task-lifecycle": runTaskLifecycleCommand,
  "task-gates": runTaskGatesCommand,
  "task-query": runTaskQueryCommand,
  governance: runGovernanceCommand,
  migration: runMigrationCommand,
  diagnostics: runDiagnosticsCommand,
  worktree: runWorktreeCommand,
  extension: runExtensionRunnerCommand,
  gui: runGuiCommand
} satisfies Record<CommandRunnerId, CommandRunner>;

export function runRegisteredCommand(
  command: ParsedCommand,
  makeEngine: () => CommandRunnerEngine,
  makeArtifactStore: () => Pick<ArtifactStore, "readTaskPackage" | "readAuthoredDocument">,
  makeCurrentSessionProbe: () => CurrentSessionProbePort,
  makeProvenanceSessionExporter: () => ProvenanceSessionExporter,
  syncExportedSession: (result: ProvenanceSessionExportResult) => Effect.Effect<void, ProvenanceSessionExporterRejected>,
  makeWriteCoordinator: (actor: { readonly kind: "agent" | "human" | "system"; readonly id: string }) => WriteCoordinator,
  actorAttribution: () => CliActorAttribution,
  makeDecisionWriteService: () => DecisionWriteService,
  makeFactWriteService: () => FactWriteService,
  makeRuntimeEventLedgerService: () => RuntimeEventLedgerService,
  runLedgerMaterializer: (rootInput: HarnessLayoutInput, options: { readonly dryRun?: boolean }) => MaterializerCommandReport
): CommandRunnerEffect {
  const runnerId = runnerIdForAction(command.action.kind);
  const runner = runnerRegistry[runnerId];
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
  let runtimeEventLedgerService: RuntimeEventLedgerService | undefined;
  const context: CommandRunnerContext = {
    rootDir: command.rootDir,
    layoutInput,
    layoutOverrides: command.layoutOverrides,
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
    get decisionWriteService() {
      decisionWriteService ??= makeDecisionWriteService();
      return decisionWriteService;
    },
    get factWriteService() {
      factWriteService ??= makeFactWriteService();
      return factWriteService;
    },
    get runtimeEventLedgerService() {
      runtimeEventLedgerService ??= makeRuntimeEventLedgerService();
      return runtimeEventLedgerService;
    },
    runLedgerMaterializer: (options) => runLedgerMaterializer(layoutInput, options)
  };
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

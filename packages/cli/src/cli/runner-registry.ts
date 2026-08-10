import { Effect } from "effect";
import type { DecisionWriteService, FactWriteService, ProvenanceSessionExporter, ProvenanceSessionExporterRejected, ProvenanceSessionExportResult, RuntimeEventLedgerService, TaskHolderPrincipal, TaskHolderService } from "@harness-anything/application";
import type { ArtifactStore, CurrentSessionProbePort, OperationalActor } from "@harness-anything/kernel";
import type { ArtifactStoreError, DomainStatus, EngineError, PriorityTier, TaskWorkKind, WriteControl } from "@harness-anything/kernel";
import type { HarnessLayoutInput, HarnessLayoutOverrides } from "@harness-anything/kernel";
import { createHarnessRuntimeContext } from "@harness-anything/kernel";
import type { WriteCoordinator } from "@harness-anything/kernel";
import { requiresConflictMarkerPreflight, taskPrincipalRequiredForAction } from "./command-event-policy.ts";
import { receiptCommandKind } from "./receipt-command-kind.ts";
import { commandSpecMap, commandSpecs, type CommandKind } from "./command-spec/index.ts";
import type { CommandSpecDefinition } from "./command-spec/types.ts";
import { commandDescriptors, commandRegistry } from "./command-registry.ts";
import type { CommandDescriptor } from "./command-registry.ts";
import {
  readCommandConflictMarkerFailure,
  type ConflictMarkerExecutionBoundary
} from "./conflict-preflight.ts";
import { cliError, CliErrorCode } from "./error-codes.ts";
import { actionTaskId } from "./parse-args.ts";
import { appendCommandRuntimeEvent } from "./command-runtime-events.ts";
import { commandFailureResult } from "./runner-failure-result.ts";
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
  readonly makeMigrationWriteCoordinator: (actor: OperationalActor, evidenceRef: string) => WriteCoordinator;
  readonly makeOperationalWriteCoordinator: (actor: OperationalActor) => WriteCoordinator;
  readonly actorAttribution: () => CliActorAttribution;
  readonly taskHolderPrincipal: () => TaskHolderPrincipal;
  readonly decisionWriteService: DecisionWriteService;
  readonly factWriteService: FactWriteService;
  readonly taskHolderService: TaskHolderService;
  readonly onCommandTelemetry?: (phase: "runtime-event-append-start" | "runtime-event-append-done") => void;
  /** True only while the daemon executes a canonical command through its authority submission. */
  readonly authorityCommandSubmission: boolean;
  /** True when the daemon supplied the read-only canonical planner for dry-run validation. */
  readonly authorityCommandPreflight: boolean;
  readonly outerProceedingRecovery: boolean;
  readonly runLedgerMaterializer: (options: { readonly dryRun?: boolean }) => MaterializerCommandReport;
}

export type CommandRunnerEffect = Effect.Effect<CliResult, ArtifactStoreError | EngineError | WriteControl>;

type EngineEffect<A> = Effect.Effect<A, EngineError | WriteControl>;

export interface CommandRunnerEngine {
  readonly createTask: (input: {
	    readonly taskId: string;
	    readonly title: string;
	    readonly idempotencyKey?: string;
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
    readonly auditText?: string;
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
  makeMigrationWriteCoordinator: (actor: OperationalActor, evidenceRef: string) => WriteCoordinator,
  makeOperationalWriteCoordinator: (actor: OperationalActor) => WriteCoordinator,
  actorAttribution: () => CliActorAttribution,
  taskHolderPrincipal: () => TaskHolderPrincipal,
  makeDecisionWriteService: () => DecisionWriteService,
  makeFactWriteService: () => FactWriteService,
  makeTaskHolderService: () => TaskHolderService,
  makeRuntimeEventLedgerService: () => RuntimeEventLedgerService,
  runLedgerMaterializer: (rootInput: HarnessLayoutInput, options: { readonly dryRun?: boolean }) => MaterializerCommandReport,
  execution: ConflictMarkerExecutionBoundary = {
    authorityCommandSubmission: false,
    outerProceedingRecovery: false
  }
): Effect.Effect<CliResult> {
  const runner = runnerRegistry[command.action.kind];
  const layoutInput = createHarnessRuntimeContext(command.rootDir, command.layoutOverrides);
  const conflictMarkerFailure = readCommandConflictMarkerFailure(command, layoutInput, execution);
  if (conflictMarkerFailure) return Effect.succeed(conflictMarkerFailure);
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
    makeMigrationWriteCoordinator,
    makeOperationalWriteCoordinator,
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
    onCommandTelemetry: execution.onCommandTelemetry,
    authorityCommandSubmission: execution.authorityCommandSubmission,
    authorityCommandPreflight: execution.authorityCommandPreflight === true,
    outerProceedingRecovery: execution.outerProceedingRecovery,
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
        command: receiptCommandKind(command.action),
        taskId: actionTaskId(command.action),
        error: cliError(CliErrorCode.AuthMissing, error instanceof Error ? error.message : String(error))
      } satisfies CliResult);
    }
  }
  return runner(context, command).pipe(
    Effect.flatMap((result) => appendCommandRuntimeEvent(context, command, result)),
    Effect.catchAll((error) => Effect.succeed(commandFailureResult(command, error)))
  );
}

export { requiresConflictMarkerPreflight };

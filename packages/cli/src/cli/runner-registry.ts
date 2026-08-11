import { Effect } from "effect";
import type { DecisionWriteService, FactWriteService, ProvenanceSessionExporter, ProvenanceSessionExporterRejected, ProvenanceSessionExportResult, RuntimeEventLedgerService } from "../../../application/src/index.ts";
import type { ArtifactStore, CurrentSessionProbePort } from "../../../kernel/src/index.ts";
import type { ActorAxes, ArtifactStoreError, EngineError, WriteError } from "../../../kernel/src/index.ts";
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
import type { AntiEntropyReceiptVerifier, GateReceiptVerifier, TaskActorAuthorizer } from "./task-lifecycle-authority.ts";

export interface CommandRunnerContext {
  readonly rootDir: string;
  readonly layoutInput: HarnessLayoutInput;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly commandSpecs: ReadonlyArray<Pick<CommandSpecDefinition, "kind" | "eventPolicy">>;
  readonly commandDescriptors: ReadonlyArray<CommandDescriptor>;
  readonly commandRegistry: ReadonlyArray<CommandRegistryEntry>;
  readonly artifactStore: Pick<ArtifactStore, "readTaskPackage" | "readAuthoredDocument">;
  readonly currentSessionProbe: CurrentSessionProbePort;
  readonly provenanceSessionExporter: ProvenanceSessionExporter;
  readonly syncExportedSession: (result: ProvenanceSessionExportResult) => Effect.Effect<void, ProvenanceSessionExporterRejected>;
  readonly runtimeEventLedgerService: RuntimeEventLedgerService;
  readonly makeWriteCoordinator: (actor: { readonly kind: "agent" | "human" | "system"; readonly id: string }) => WriteCoordinator;
  readonly actorAttribution: () => CliActorAttribution;
  readonly actorAxes: () => ActorAxes;
  readonly verifyAntiEntropyReceipt?: AntiEntropyReceiptVerifier;
  readonly authorizeTaskLifecycleActor?: TaskActorAuthorizer;
  readonly verifyGateReceipt?: GateReceiptVerifier;
  readonly decisionWriteService: DecisionWriteService;
  readonly factWriteService: FactWriteService;
  readonly runLedgerMaterializer: (options: { readonly dryRun?: boolean }) => MaterializerCommandReport;
}

export type CommandRunnerEffect = Effect.Effect<CliResult, ArtifactStoreError | EngineError | WriteError>;

export type CommandRunner = (
  context: CommandRunnerContext,
  command: ParsedCommand
) => CommandRunnerEffect;

export const runnerRegistry = commandSpecMap((spec) => spec.run) satisfies Record<CommandKind, CommandRunner>;

export function runRegisteredCommand(
  command: ParsedCommand,
  makeArtifactStore: () => Pick<ArtifactStore, "readTaskPackage" | "readAuthoredDocument">,
  makeCurrentSessionProbe: () => CurrentSessionProbePort,
  makeProvenanceSessionExporter: () => ProvenanceSessionExporter,
  syncExportedSession: (result: ProvenanceSessionExportResult) => Effect.Effect<void, ProvenanceSessionExporterRejected>,
  makeWriteCoordinator: (actor: { readonly kind: "agent" | "human" | "system"; readonly id: string }) => WriteCoordinator,
  actorAttribution: () => CliActorAttribution,
  actorAxes: () => ActorAxes,
  makeDecisionWriteService: () => DecisionWriteService,
  makeFactWriteService: () => FactWriteService,
  makeRuntimeEventLedgerService: () => RuntimeEventLedgerService,
  runLedgerMaterializer: (rootInput: HarnessLayoutInput, options: { readonly dryRun?: boolean }) => MaterializerCommandReport,
  verifyAntiEntropyReceipt: AntiEntropyReceiptVerifier | undefined,
  authorizeTaskLifecycleActor: TaskActorAuthorizer,
  verifyGateReceipt: GateReceiptVerifier
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
    commandSpecs,
    commandDescriptors,
    commandRegistry,
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
    actorAxes,
    verifyAntiEntropyReceipt,
    authorizeTaskLifecycleActor,
    verifyGateReceipt,
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
  if (taskPrincipalRequiredForAction(command.action)) {
    try {
      context.actorAxes();
    } catch (error) {
      return Effect.succeed({
        ok: false,
        command: command.action.kind,
        taskId: actionTaskId(command.action),
        error: cliError(CliErrorCode.AuthMissing, error instanceof Error ? error.message : String(error))
      } satisfies CliResult);
    }
  }
  const commandEffect: CommandRunnerEffect = runner(context, command);
  return commandEffect.pipe(
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

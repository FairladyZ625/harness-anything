import { Effect } from "effect";
import type { DecisionWriteService, FactWriteService, ProvenanceSessionExporter, RuntimeEventLedgerService } from "../../../application/src/index.ts";
import type { CurrentSessionProbePort } from "../../../kernel/src/index.ts";
import type { ArtifactStoreError, DomainStatus, EngineError, WriteError } from "../../../kernel/src/domain/index.ts";
import type { HarnessLayoutInput, HarnessLayoutOverrides } from "../../../kernel/src/layout/index.ts";
import { createHarnessRuntimeContext } from "../../../kernel/src/layout/index.ts";
import type { WriteCoordinator } from "../../../kernel/src/ports/index.ts";
import { findConflictMarkerWarnings } from "../../../kernel/src/projection/post-merge-checks.ts";
import type { CommandKind, CommandRunnerId } from "./command-registry.ts";
import { runnerIdForAction } from "./command-registry.ts";
import { cliError, CliErrorCode } from "./error-codes.ts";
import type { CliResult, ParsedCommand } from "./types.ts";
import {
  runDiagnosticsCommand,
  runDecisionCommand,
  runDistillCommand,
  runDocCommand,
  runExtensionRunnerCommand,
  runFactCommand,
  runGovernanceCommand,
  runGuiCommand,
  runHelpCommand,
  runInitCommand,
  runMigrationCommand,
  runNewTaskCommand,
  runRuntimeEventCommand,
  runTaskGatesCommand,
  runTaskLifecycleCommand,
  runTaskQueryCommand,
  runVersionCommand
} from "../commands/core/index.ts";

export interface CommandRunnerContext {
  readonly rootDir: string;
  readonly layoutInput: HarnessLayoutInput;
  readonly layoutOverrides?: HarnessLayoutOverrides;
  readonly engine: CommandRunnerEngine;
  readonly currentSessionProbe: CurrentSessionProbePort;
  readonly provenanceSessionExporter: ProvenanceSessionExporter;
  readonly runtimeEventLedgerService: RuntimeEventLedgerService;
  readonly makeWriteCoordinator: (actor: { readonly kind: "agent" | "human" | "system"; readonly id: string }) => WriteCoordinator;
  readonly decisionWriteService: DecisionWriteService;
  readonly factWriteService: FactWriteService;
}

export type CommandRunnerEffect = Effect.Effect<CliResult, ArtifactStoreError | EngineError | WriteError>;

type EngineEffect<A> = Effect.Effect<A, EngineError | WriteError>;

export interface CommandRunnerEngine {
  readonly createTask: (input: {
    readonly taskId: string;
    readonly title: string;
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
  version: runVersionCommand,
  init: runInitCommand,
  "new-task": runNewTaskCommand,
  decision: runDecisionCommand,
  distill: runDistillCommand,
  fact: runFactCommand,
  "runtime-event": runRuntimeEventCommand,
  doc: runDocCommand,
  "task-lifecycle": runTaskLifecycleCommand,
  "task-gates": runTaskGatesCommand,
  "task-query": runTaskQueryCommand,
  governance: runGovernanceCommand,
  migration: runMigrationCommand,
  diagnostics: runDiagnosticsCommand,
  extension: runExtensionRunnerCommand,
  gui: runGuiCommand
} satisfies Record<CommandRunnerId, CommandRunner>;

export function runRegisteredCommand(
  command: ParsedCommand,
  makeEngine: () => CommandRunnerEngine,
  makeCurrentSessionProbe: () => CurrentSessionProbePort,
  makeProvenanceSessionExporter: () => ProvenanceSessionExporter,
  makeWriteCoordinator: (actor: { readonly kind: "agent" | "human" | "system"; readonly id: string }) => WriteCoordinator,
  makeDecisionWriteService: () => DecisionWriteService,
  makeFactWriteService: () => FactWriteService,
  makeRuntimeEventLedgerService: () => RuntimeEventLedgerService
): CommandRunnerEffect {
  const runnerId = runnerIdForAction(command.action.kind);
  const runner = runnerRegistry[runnerId];
  const layoutInput = createHarnessRuntimeContext(command.rootDir, command.layoutOverrides);
  const conflictMarkerWarning = requiresConflictMarkerPreflight(command.action)
    ? findConflictMarkerWarnings(layoutInput)[0]
    : undefined;
  if (conflictMarkerWarning) {
    return Effect.succeed({
      ok: false,
      command: command.action.kind,
      warnings: [conflictMarkerWarning],
      error: cliError(CliErrorCode.ConflictMarkerPresent, conflictMarkerWarning.message)
    } satisfies CliResult);
  }
  let engine: CommandRunnerEngine | undefined;
  let currentSessionProbe: CurrentSessionProbePort | undefined;
  let provenanceSessionExporter: ProvenanceSessionExporter | undefined;
  let decisionWriteService: DecisionWriteService | undefined;
  let factWriteService: FactWriteService | undefined;
  let runtimeEventLedgerService: RuntimeEventLedgerService | undefined;
  return runner({
    rootDir: command.rootDir,
    layoutInput,
    layoutOverrides: command.layoutOverrides,
    get engine() {
      engine ??= makeEngine();
      return engine;
    },
    get currentSessionProbe() {
      currentSessionProbe ??= makeCurrentSessionProbe();
      return currentSessionProbe;
    },
    get provenanceSessionExporter() {
      provenanceSessionExporter ??= makeProvenanceSessionExporter();
      return provenanceSessionExporter;
    },
    makeWriteCoordinator,
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
    }
  }, command);
}

const conflictMarkerPreflightByKind = {
  help: false,
  version: false,
  init: true,
  "new-task": true,
  "status-set": true,
  "progress-append": true,
  "task-archive": true,
  "task-supersede": true,
  "task-delete": true,
  "task-reopen": true,
  "task-review": true,
  "task-complete": true,
  "decision-list": false, "decision-show": false,
  "decision-propose": true,
  "decision-accept": true,
  "decision-reject": true,
  "decision-defer": true,
  "decision-supersede": true,
  "decision-amend": true,
  "decision-retire": true,
  "record-fact": true,
  "distill-candidate": true,
  "distill-commit": true,
  "runtime-event-append": true,
  "runtime-event-list": false,
  "doc-list": false, "doc-map": false,
  "template-list": false,
  "template-render": false,
  "task-list": true,
  status: true,
  check: false,
  "governance-rebuild": true,
  "lesson-promote": true,
  "lesson-sediment": true,
  "adopt-multica": true,
  "snapshot-multica": false,
  "migrate-plan": false,
  "migrate-structure": true,
  "migrate-provenance": true,
  "migrate-run": true,
  "migrate-verify": false,
  "legacy-scan": false,
  "legacy-intake-plan": true,
  "legacy-copy-safe-docs": true,
  "legacy-index": true,
  "legacy-verify": false,
  "git-diff": false,
  doctor: false,
  "preset-validate": false,
  "preset-list": false,
  "preset-inspect": false,
  "preset-check": false,
  "preset-install": true,
  "preset-seed": true,
  "preset-audit": false,
  "preset-uninstall": true,
  "preset-run": true,
  "preset-action": true,
  "script-list": false,
  "script-inspect": false,
  "script-run": true,
  "module-list": false,
  "module-inspect": false,
  "module-register": true,
  "module-scaffold": true,
  "module-unregister": true,
  "module-step": true,
  "vertical-validate": false,
  gui: false
} as const satisfies Record<CommandKind, boolean>;

export function requiresConflictMarkerPreflight(action: ParsedCommand["action"] | CommandKind): boolean {
  const kind = typeof action === "string" ? action : action.kind;
  return conflictMarkerPreflightByKind[kind];
}

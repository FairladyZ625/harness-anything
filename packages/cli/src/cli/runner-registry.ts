import { Effect } from "effect";
import type { DecisionWriteService, FactWriteService, ProvenanceSessionExporter, RuntimeEventLedgerService } from "../../../application/src/index.ts";
import type { CurrentSessionProbePort } from "../../../kernel/src/index.ts";
import type { ArtifactStoreError, DomainStatus, EngineError, WriteError } from "../../../kernel/src/domain/index.ts";
import type { HarnessLayoutInput, HarnessLayoutOverrides } from "../../../kernel/src/layout/index.ts";
import { createHarnessRuntimeContext } from "../../../kernel/src/layout/index.ts";
import type { WriteCoordinator } from "../../../kernel/src/ports/index.ts";
import { findConflictMarkerWarnings } from "../../../kernel/src/projection/post-merge-checks.ts";
import { requiresConflictMarkerPreflight, runtimeEventPolicyForAction } from "./command-event-policy.ts";
import type { CommandRunnerId } from "./command-registry.ts";
import { runnerIdForAction } from "./command-registry.ts";
import { cliError, CliErrorCode } from "./error-codes.ts";
import { actionTaskId } from "./parse-args.ts";
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
  const context: CommandRunnerContext = {
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
  };
  return runner(context, command).pipe(
    Effect.flatMap((result) => appendCommandRuntimeEvent(context, command, result))
  );
}

export { requiresConflictMarkerPreflight };

function appendCommandRuntimeEvent(
  context: CommandRunnerContext,
  command: ParsedCommand,
  result: CliResult
): CommandRunnerEffect {
  if (!result.ok || runtimeEventPolicyForAction(command.action) !== "auto") return Effect.succeed(result);
  return context.currentSessionProbe.currentSession.pipe(
    Effect.flatMap((session) => context.runtimeEventLedgerService.append({
      kind: "result",
      session: {
        sessionId: session.sessionId,
        runtime: session.runtime,
        ...eventEntityRefs(command.action, result)
      },
      result: {
        status: "succeeded",
        summary: `CLI command succeeded: ${command.action.kind}`
      }
    })),
    Effect.match({
      onFailure: (error): CliResult => ({
        ok: false,
        command: command.action.kind,
        ...eventEntityRefs(command.action, result),
        error: cliError(CliErrorCode.RuntimeEventLedgerRejected, `${error.sessionId}: ${error.reason}`)
      }),
      onSuccess: (): CliResult => result
    })
  );
}

function eventEntityRefs(
  action: ParsedCommand["action"],
  result: CliResult
): { readonly taskId?: string; readonly decisionId?: string; readonly factRef?: string } {
  const taskId = result.taskId ?? actionTaskId(action);
  const decisionId = result.decisionId ?? ("decisionId" in action ? action.decisionId : undefined);
  const factRef = result.factRef;
  return {
    ...(taskId ? { taskId } : {}),
    ...(decisionId ? { decisionId } : {}),
    ...(factRef ? { factRef } : {})
  };
}

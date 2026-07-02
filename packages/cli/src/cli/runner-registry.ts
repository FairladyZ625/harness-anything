import { Effect } from "effect";
import type { ArtifactStoreError, DomainStatus, EngineError, WriteError } from "../../../kernel/src/domain/index.ts";
import type { HarnessLayoutInput, HarnessLayoutOverrides } from "../../../kernel/src/layout/index.ts";
import { createHarnessRuntimeContext } from "../../../kernel/src/layout/index.ts";
import type { CommandRunnerId } from "./command-registry.ts";
import { runnerIdForAction } from "./command-registry.ts";
import type { CliResult, ParsedCommand } from "./types.ts";
import {
  runDiagnosticsCommand,
  runExtensionRunnerCommand,
  runGovernanceCommand,
  runGuiCommand,
  runHelpCommand,
  runInitCommand,
  runMigrationCommand,
  runNewTaskCommand,
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
  engine: CommandRunnerEngine,
  command: ParsedCommand
): CommandRunnerEffect {
  const runnerId = runnerIdForAction(command.action.kind);
  const runner = runnerRegistry[runnerId];
  return runner({
    rootDir: command.rootDir,
    layoutInput: createHarnessRuntimeContext(command.rootDir, command.layoutOverrides),
    layoutOverrides: command.layoutOverrides,
    engine
  }, command);
}

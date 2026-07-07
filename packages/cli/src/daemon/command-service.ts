import type { JsonObject } from "../../../daemon/src/index.ts";
import { toCommandReceipt, type CommandFailureReceipt, type CommandReceipt } from "../cli/receipt.ts";
import type { ParsedCommand } from "../cli/types.ts";
import { isPlainRecord } from "../cli/value-utils.ts";
import { runRegisteredCommandWithCliComposition } from "../composition/command-executor.ts";
import { makeDaemonQueuedWriteCoordinator, type CliDaemonRuntime } from "./queued-write-coordinator.ts";

export interface CliCommandService {
  readonly runCommand: (payload?: JsonObject) => Promise<CommandReceipt | CommandFailureReceipt>;
}

export interface CliCommandServiceOptions {
  readonly onCommandStart?: () => void;
  readonly onCommandSettled?: () => void;
}

export function createCliCommandService(runtime: CliDaemonRuntime, options: CliCommandServiceOptions = {}): CliCommandService {
  return {
    runCommand: async (payload) => {
      options.onCommandStart?.();
      const command = readParsedCommandPayload(payload);
      try {
        const result = await runRegisteredCommandWithCliComposition(command, {
          makeWriteCoordinator: (actor) => makeDaemonQueuedWriteCoordinator(
            runtime,
            `${command.action.kind}:${actor.kind}:${actor.id}`
          )
        });
        return toCommandReceipt(result);
      } finally {
        options.onCommandSettled?.();
      }
    }
  };
}

function readParsedCommandPayload(payload: JsonObject | undefined): ParsedCommand {
  const command = payload?.command;
  if (!isPlainRecord(command) || typeof command.rootDir !== "string" || !isPlainRecord(command.action) || typeof command.action.kind !== "string") {
    throw new Error("command.run requires payload.command parsed by the CLI parser.");
  }
  return command as unknown as ParsedCommand;
}

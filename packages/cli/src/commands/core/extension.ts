import { Effect } from "effect";
import { runExtensionCommand } from "../extensions/index.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";

export const runExtensionRunnerCommand: CommandRunner = (_context, command) =>
  Effect.sync(() => runExtensionCommand(command));

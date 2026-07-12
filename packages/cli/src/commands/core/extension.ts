import { Effect } from "effect";
import { runExtensionCommand } from "../extensions/index.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";

export const runExtensionRunnerCommand: CommandRunner = (context, command) =>
  Effect.sync(() => runExtensionCommand(command, context.makeWriteCoordinator({ scope: "operational", kind: "agent", id: "extension" })));

import { Effect } from "effect";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";

export const runAuthorityCutoverCommand: CommandRunner = (_context, command) => Effect.succeed({
  ok: false,
  command: command.action.kind,
  error: cliError(
    CliErrorCode.EngineNotEnabled,
    "Authority cutover controls require a production daemon started with --authority-manifest."
  )
} satisfies CliResult);

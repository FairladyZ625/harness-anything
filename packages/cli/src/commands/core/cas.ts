import { Effect } from "effect";
import { collectCasGarbage } from "@harness-anything/application";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";

export const runCasCommand: CommandRunner = (context, command) => {
  if (command.action.kind !== "cas-gc") {
    return Effect.succeed(casFailure("Unsupported CAS command."));
  }
  try {
    const report = collectCasGarbage(context.layoutInput, { apply: command.action.mode === "apply" });
    return Effect.succeed({
      ok: true,
      command: "cas-gc",
      rows: report.orphans.length,
      mode: command.action.mode,
      report
    } satisfies CliResult);
  } catch (error) {
    return Effect.succeed(casFailure(error instanceof Error ? error.message : String(error)));
  }
};

function casFailure(message: string): CliResult {
  return {
    ok: false,
    command: "cas-gc",
    error: cliError(CliErrorCode.ArtifactWriteRejected, message)
  };
}

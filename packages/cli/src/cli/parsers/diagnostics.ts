import { cliError, CliErrorCode } from "../error-codes.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseDiagnosticsArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] !== "diagnostics") return null;
  if (args[1] !== "command-usage") {
    return { ok: false, error: cliError(CliErrorCode.UnknownCommand, "Use diagnostics command-usage.") };
  }
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: { kind: "diagnostics-command-usage" }
    }
  };
}

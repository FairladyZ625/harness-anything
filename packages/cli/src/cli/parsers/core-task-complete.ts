import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseTaskComplete(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const ciGate = readOption(args, "--ci");
  if (ciGate !== undefined && ciGate !== "passed" && ciGate !== "failed" && ciGate !== "not-applicable") {
    return { ok: false, error: cliError(CliErrorCode.InvalidCiGate, `Unknown CI gate: ${ciGate}. Valid CI gate values: passed, failed, not-applicable.`) };
  }
  const commitRef = readOption(args, "--commit-anchor");
  const judgment = readOption(args, "--judgment");
  if (Boolean(commitRef) !== Boolean(judgment)) {
    return { ok: false, error: cliError(CliErrorCode.CompletionEvidenceModeInvalid, "Use --commit-anchor and --judgment together, or omit both for Execution/Review completion.") };
  }
  if (commitRef && args.includes("--reviewer")) {
    return { ok: false, error: cliError(CliErrorCode.CompletionEvidenceModeInvalid, "Commit-anchor completion records the authenticated judge; --reviewer belongs only to Execution/Review completion.") };
  }
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: "task-complete",
        taskId: args[1]!,
        ...(ciGate ? { ciGate } : {}),
        reviewerId: readOption(args, "--reviewer") ?? "local-reviewer",
        evidenceMode: commitRef ? "commit-anchor" : "execution-review",
        ...(commitRef ? { commitRef, judgment } : {})
      }
    }
  };
}

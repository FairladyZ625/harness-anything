import { reviewVerdicts } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseTaskReviewExecution(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const executionId = readOption(args, "--execution-id");
  const verdict = readOption(args, "--verdict");
  const findings = readOption(args, "--findings");
  if (!executionId || !verdict || !findings) {
    return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, "task review-execution requires --execution-id, --verdict, and --findings.") };
  }
  if (!(reviewVerdicts as ReadonlyArray<string>).includes(verdict)) {
    return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, `Unknown Review verdict: ${verdict}. Valid verdicts: ${reviewVerdicts.join(", ")}.`) };
  }
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: "task-review-execution",
        taskId: args[2],
        executionId,
        verdict: verdict as (typeof reviewVerdicts)[number],
        findings,
        archiveWarningsAcknowledged: args.includes("--acknowledge-archive-warnings")
      }
    }
  };
}

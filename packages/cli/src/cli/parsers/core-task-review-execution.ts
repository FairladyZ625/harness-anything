import { reviewVerdicts } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption, readRepeatedRawOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseTaskReviewExecution(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const executionId = readOption(args, "--execution-id");
  const verdict = readOption(args, "--verdict");
  const findings = readOption(args, "--findings");
  const rationale = readOption(args, "--rationale");
  if (!executionId || !verdict || !findings) {
    return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, "task review-execution requires --execution-id, --verdict, --findings, and --rationale.") };
  }
  if (!(reviewVerdicts as ReadonlyArray<string>).includes(verdict)) {
    return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, `Unknown Review verdict: ${verdict}. Valid verdicts: ${reviewVerdicts.join(", ")}.`) };
  }
  if (!rationale) return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, "task review-execution requires --rationale.") };
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
        evidenceChecked: readRepeatedRawOption(args, "--evidence-checked").filter((value): value is string => value !== undefined),
        rationale,
        archiveWarningsAcknowledged: args.includes("--acknowledge-archive-warnings")
      }
    }
  };
}

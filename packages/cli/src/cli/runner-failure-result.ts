import {
  isIndeterminateFlushControlOutcome,
  type ArtifactStoreError,
  type EngineError,
  type WriteControl
} from "@harness-anything/kernel";
import { cliError, CliErrorCode } from "./error-codes.ts";
import { toCliError } from "./error-mapper.ts";
import { actionTaskId } from "./parse-args.ts";
import { receiptCommandKind } from "./receipt-command-kind.ts";
import type { CliResult, ParsedCommand } from "./types.ts";

export function commandFailureResult(
  command: ParsedCommand,
  error: ArtifactStoreError | EngineError | WriteControl
): CliResult {
  const base = {
    ok: false as const,
    command: receiptCommandKind(command.action),
    taskId: actionTaskId(command.action)
  };
  if (!isIndeterminateFlushControlOutcome(error)) {
    return { ...base, error: toCliError(error) };
  }
  return {
    ...base,
    report: {
      schema: "write-outcome-indeterminate/v1",
      status: "indeterminate",
      flush: error.report
    },
    error: cliError(
      CliErrorCode.WriteOutcomeIndeterminate,
      `Write outcome is unknown for ${error.report.operationIds.join(",")}. Run 'ha daemon logs --errors --json', compare those IDs with canonical Git state, and do not retry the original write blindly.`,
      { operationIds: error.report.operationIds, cause: error.report.cause }
    )
  };
}

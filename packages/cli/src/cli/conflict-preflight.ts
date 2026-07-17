import type { HarnessLayoutInput, ProjectionWarning } from "../../../kernel/src/index.ts";
import { findConflictMarkerWarnings } from "../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "./error-codes.ts";
import type { CliResult } from "./types.ts";

export function readConflictMarkerPreflight(command: string, layoutInput: HarnessLayoutInput): {
  readonly ok: true;
  readonly warning?: ProjectionWarning;
} | {
  readonly ok: false;
  readonly result: CliResult;
} {
  try {
    return { ok: true, warning: findConflictMarkerWarnings(layoutInput)[0] };
  } catch (error) {
    return {
      ok: false,
      result: {
        ok: false,
        command,
        error: cliError(
          CliErrorCode.ProjectionCheckFailed,
          `Conflict marker preflight could not read authored sources: ${preflightErrorMessage(error)}`
        )
      }
    };
  }
}

function preflightErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.trim().split(/\r?\n/u)[0] ?? "unknown error";
  return String(error);
}

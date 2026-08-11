import type { HarnessLayoutInput, ProjectionWarning } from "@harness-anything/kernel";
import type { RuntimeEventLedgerService } from "@harness-anything/application";
import { findConflictMarkerWarnings } from "@harness-anything/kernel";
import { cliError, CliErrorCode } from "./error-codes.ts";
import { requiresConflictMarkerPreflight } from "./command-event-policy.ts";
import { receiptCommandKind } from "./receipt-command-kind.ts";
import type { CliResult, ParsedCommand } from "./types.ts";

export interface ConflictMarkerExecutionBoundary {
  readonly authorityCommandSubmission: boolean;
  readonly authorityCommandPreflight?: boolean;
  readonly outerProceedingRecovery: boolean;
  readonly onTelemetry?: (phase: "command-conflict-preflight" | "command-conflict-recheck") => void;
  readonly onCommandTelemetry?: (phase: "runtime-event-append-start" | "runtime-event-append-done") => void;
  readonly deferCommandRuntimeEvent?: (append: () => Promise<CliResult>) => void;
  /** Local-only durable sink for automatic command audit. */
  readonly automaticRuntimeEventLedgerService?: RuntimeEventLedgerService;
  readonly conflictMarkerPreflight?: () => ProjectionWarning | undefined;
}

export function readCommandConflictMarkerFailure(
  command: ParsedCommand,
  layoutInput: HarnessLayoutInput,
  execution: ConflictMarkerExecutionBoundary
): CliResult | undefined {
  if (!requiresConflictMarkerPreflight(command.action)) return undefined;
  const result = readConflictMarkerPreflight(
    receiptCommandKind(command.action),
    layoutInput,
    execution.conflictMarkerPreflight
  );
  execution.onTelemetry?.("command-conflict-preflight");
  if (!result.ok) return result.result;
  if (!result.warning) return undefined;
  return {
    ok: false,
    command: receiptCommandKind(command.action),
    warnings: [result.warning],
    error: cliError(CliErrorCode.ConflictMarkerPresent, result.warning.message)
  } satisfies CliResult;
}

export function readConflictMarkerPreflight(
  command: string,
  layoutInput: HarnessLayoutInput,
  readWarning: (() => ProjectionWarning | undefined) | undefined = undefined
): {
  readonly ok: true;
  readonly warning?: ProjectionWarning;
} | {
  readonly ok: false;
  readonly result: CliResult;
} {
  try {
    return {
      ok: true,
      warning: readWarning ? readWarning() : findConflictMarkerWarnings(layoutInput)[0]
    };
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

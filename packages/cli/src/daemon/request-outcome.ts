import type { DaemonJsonRpcRequestTimeoutError } from "@harness-anything/daemon";
import { CliErrorCode, cliError } from "../cli/error-codes.ts";
import type { CommandFailureReceipt } from "../cli/receipt.ts";
import { toCommandReceipt } from "../cli/receipt.ts";
import { receiptCommandKind } from "../cli/receipt-command-kind.ts";
import type { ParsedCommand } from "../cli/types.ts";

export function daemonRequestTimeoutReceipt(
  command: ParsedCommand,
  error: DaemonJsonRpcRequestTimeoutError
): CommandFailureReceipt {
  const taskId = "taskId" in command.action && typeof command.action.taskId === "string"
    && command.action.taskId.trim().length > 0
    ? command.action.taskId
    : undefined;
  const query = {
    schema: "command-outcome-query/v1" as const,
    method: taskId ? "task.show" as const : "task.list" as const,
    parameters: taskId ? { taskId } : {},
    retry: "forbidden-until-queried" as const
  };
  const receipt = toCommandReceipt({
    ok: false,
    command: receiptCommandKind(command.action),
    error: cliError(
      CliErrorCode.DaemonRequestOutcomeUnknown,
      `Daemon request timed out, so the outcome is unknown: the write may already have taken effect even though no response arrived. Do not rerun this write blindly. First verify the target with the machine-readable query in details.data.query. Cause: ${error.message}`
    )
  });
  if (receipt.ok) throw new Error("daemon request timeout receipt unexpectedly succeeded");
  return {
    ...receipt,
    details: {
      ...(receipt.details ?? {}),
      data: {
        ...((receipt.details?.data ?? {}) as Record<string, unknown>),
        outcome: "unknown",
        query
      }
    }
  };
}

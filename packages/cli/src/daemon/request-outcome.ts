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
  const receipt = toCommandReceipt({
    ok: false,
    command: receiptCommandKind(command.action),
    error: cliError(
      CliErrorCode.DaemonRequestOutcomeUnknown,
      `Daemon request timed out, so the outcome is unknown: the write may already have taken effect even though no response arrived. Do not rerun this write blindly. First verify whether the target entity already exists or reflects the requested change (for task creation, run 'ha task list' and inspect the task title or ID; for a known task ID, run 'ha task show <task-id>'). Only decide whether to retry after that check. Cause: ${error.message}`
    )
  });
  if (receipt.ok) throw new Error("daemon request timeout receipt unexpectedly succeeded");
  return receipt;
}

import { CliErrorCode, cliError } from "../cli/error-codes.ts";
import { toCommandReceipt, type CommandFailureReceipt } from "../cli/receipt.ts";
import { receiptCommandKind } from "../cli/receipt-command-kind.ts";
import type { ParsedCommand } from "../cli/types.ts";
import { CliRootResolutionError, rootResolutionUnavailableHint } from "./root-resolution.ts";

export function rootResolutionUnavailableReceipt(
  command: ParsedCommand,
  error: CliRootResolutionError
): CommandFailureReceipt {
  const receipt = toCommandReceipt({
    ok: false,
    command: receiptCommandKind(command.action),
    error: cliError(CliErrorCode.HarnessRootUnresolved, rootResolutionUnavailableHint(error.resolution))
  });
  if (receipt.ok) throw new Error("root resolution unavailable receipt unexpectedly succeeded");
  return receipt;
}

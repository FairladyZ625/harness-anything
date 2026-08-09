import type { JsonObject } from "@harness-anything/daemon";
import { CliErrorCode, cliError } from "../cli/error-codes.ts";
import type { CommandFailureReceipt, CommandReceipt } from "../cli/receipt.ts";

export function normalizeDocSyncSubmitReceipt(
  response: JsonObject
): CommandReceipt | CommandFailureReceipt {
  const receipt = response as unknown as CommandReceipt | CommandFailureReceipt;
  if (!receipt.ok) return { ...receipt, command: "doc sync submit", action: "submit" };
  const data = (receipt.details?.data ?? {}) as Record<string, unknown>;
  const appliedChanges = Array.isArray(data.appliedChanges) ? data.appliedChanges : [];
  if (!receipt.settlement
    && appliedChanges.length > 0
    && data.settlementMode !== "synchronous-canonical-final/v1") {
    return {
      ok: false,
      schema: "command-receipt/v2",
      command: "doc sync submit",
      action: "submit",
      summary: "Doc sync may already have taken effect, but the daemon did not negotiate settlement status. Do not replay this write.",
      error: cliError(
        CliErrorCode.WriteRejected,
        "The write may already have taken effect. Inspect daemon/build status and canonical Git before deciding any recovery; do not retry the original command."
      ),
      details: {
        legacyReceipt: receipt as unknown as Record<string, unknown>,
        data: { report: data }
      },
      meta: {
        generatedAt: receipt.meta.generatedAt,
        compatibility: { legacyReceipt: receipt.meta.compatibility.legacyReceipt }
      }
    };
  }
  return {
    ...receipt,
    command: "doc sync submit",
    action: "submit",
    details: {
      ...(receipt.details ?? {}),
      data: { report: data }
    }
  };
}

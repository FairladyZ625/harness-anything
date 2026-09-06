import type { JsonObject } from "../../../daemon/src/protocol/json-rpc-types.ts";
import { cliErrorMessage } from "../cli-error.ts";
import type { ThinCommand } from "../cli/thin-command.ts";

// This is a follower wait, never a retry of the accepted write. A disconnect must retain its durable receipt.
export async function settleCommandVisibility(
  command: ThinCommand,
  receipt: JsonObject,
  read: (opId: string) => Promise<JsonObject>,
): Promise<JsonObject> {
  if (
    command.noWait ||
    command.action.kind === "receipt-show" ||
    receipt.status !== "accepted_durable" ||
    typeof receipt.opId !== "string"
  )
    return receipt;
  try {
    const observed = await read(receipt.opId);
    if (observed.status !== "accepted_durable" || observed.opId !== receipt.opId)
      return { ...receipt, visibilityWaitError: "Receipt visibility could not be observed; inspect receipt show." };
    const fields = [
      "status",
      "acceptance",
      "projection",
      "git",
      "worktree",
      "replica",
      "wait",
      "proof",
      "cut",
      "commitSha",
      "canonicalVisible",
      "worktreeVisible",
      "revision",
    ];
    return {
      ...receipt,
      ...Object.fromEntries(fields.filter((key) => key in observed).map((key) => [key, observed[key]])),
    };
  } catch (error) {
    return { ...receipt, visibilityWaitError: cliErrorMessage(error) };
  }
}

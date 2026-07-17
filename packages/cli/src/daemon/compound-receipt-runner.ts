import { createCompoundReceiptServiceV2 } from "../../../application/src/index.ts";
import { readOption } from "../cli/parse-options.ts";
import { createDurableCompoundReceiptStoreV2, renderCompoundCliExit } from "../receipt/index.ts";

/**
 * Top-level CLI owner for the compound exit contract.  A recovered waiter is
 * classified only from durable state; this command never infers success from a
 * lost RESULT_PREPARED/ACK_COMMITTED transport frame.
 */
export async function runCompoundReceiptExitCommand(argv: ReadonlyArray<string>): Promise<number | undefined> {
  if (argv[0] !== "compound-receipt" || argv[1] !== "exit") return undefined;
  const stateDirectory = required(argv, "--state-dir");
  const workspaceId = required(argv, "--workspace-id");
  const viewId = required(argv, "--view-id");
  const opId = required(argv, "--op-id");
  const waiterId = required(argv, "--waiter-id");
  const resultToken = required(argv, "--result-token");
  if (!stateDirectory || !workspaceId || !viewId || !opId || !waiterId || !resultToken) {
    return emitCompoundExit(renderCompoundCliExit({ kind: "USAGE_ERROR" }), argv.includes("--json"));
  }
  try {
    const receipt = await createCompoundReceiptServiceV2({
      store: createDurableCompoundReceiptStoreV2({ directory: stateDirectory })
    }).getWaiter({ workspaceId, viewId, opId, waiterId, resultToken });
    return emitCompoundExit(renderCompoundCliExit(receipt ? { kind: "RECEIPT", receipt } : { kind: "INTERNAL_ERROR" }), argv.includes("--json"));
  } catch {
    return emitCompoundExit(renderCompoundCliExit({ kind: "INTERNAL_ERROR" }), argv.includes("--json"));
  }
}

function required(argv: ReadonlyArray<string>, name: string): string | undefined {
  const value = readOption(argv, name);
  return value && !value.startsWith("--") ? value : undefined;
}

function emitCompoundExit(output: ReturnType<typeof renderCompoundCliExit>, json: boolean): number {
  if (json) console.log(JSON.stringify(output.json));
  else console.error(output.stderr);
  return output.exitCode;
}

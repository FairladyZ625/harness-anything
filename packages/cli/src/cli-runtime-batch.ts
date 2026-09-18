import type { JsonObject } from "../../daemon/src/protocol/json-rpc-types.ts";
import { cliErrorMessage } from "./cli-error.ts";
import { runtimeRejected } from "./cli-runtime-auth.ts";
import { readRuntimeBatchFile } from "./cli-runtime-batch-input.ts";
import type { ThinCommand } from "./cli/thin-command.ts";
import { consumeKnownError, runCommandThroughDaemon } from "./daemon/client.ts";

/** runtime-batch is one daemon request: the declaration crosses the wire verbatim and the
 * RepoCell owns the concurrency window, per-entry settlement, and the aggregate receipt. */
export async function runRuntimeBatch(command: ThinCommand): Promise<JsonObject> {
  let declaration: string;
  try {
    declaration = readRuntimeBatchFile(command);
  } catch (error) {
    consumeKnownError(error);
    return runtimeRejected("runtime-batch", "batch_file_invalid", cliErrorMessage(error));
  }
  return runCommandThroughDaemon({
    ...command,
    action: { kind: "runtime-batch", declaration },
  });
}

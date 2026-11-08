import { cliErrorMessage } from "./cli-error.ts";
import { commandDescriptorForAction } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { readCliInputFile } from "./cli-input-codec.ts";
import type { ThinCommand } from "./cli/thin-command.ts";

/** The batch declaration's parse and execution contract lives in the daemon; the transport only
 * hands the declared document across verbatim. The declaration is repository content, so it obeys
 * the same workspace-relative containment as every other CLI file input. */
export function readRuntimeBatchFile(command: ThinCommand): string {
  const requested = command.action.batchFile;
  if (typeof requested !== "string" || requested.length === 0)
    throw Object.assign(new Error("runtime batch requires a <batch-file> inside the selected repository."), {
      code: "missing_field",
    });
  try {
    const descriptor = commandDescriptorForAction(command.action.kind);
    if (!("positionalInputs" in descriptor) || !descriptor.positionalInputs?.[0])
      throw new Error("runtime batch requires a declared file codec.");
    return readCliInputFile(command.rootDir, requested, descriptor.positionalInputs[0]);
  } catch (error) {
    if ((error as { code?: unknown }).code === "invalid_field") throw error;
    throw new Error(`Could not read batch declaration: ${cliErrorMessage(error)}`);
  }
}

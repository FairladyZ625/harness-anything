import { cliErrorMessage } from "./cli-error.ts";
import type { ThinCommand } from "./cli/thin-command.ts";
import { readFileSync } from "node:fs";
import path from "node:path";

/** The batch declaration's parse and execution contract lives in the daemon; the transport only
 * hands the declared document across verbatim. The declaration is repository content, so it obeys
 * the same workspace-relative containment as every other CLI file input. */
export function readRuntimeBatchFile(command: ThinCommand): string {
  const requested = command.action.batchFile;
  if (typeof requested !== "string" || requested.length === 0)
    throw Object.assign(new Error("runtime batch requires a <batch-file> inside the selected repository."), {
      code: "missing_field",
    });
  const batchPath = path.resolve(command.rootDir, requested),
    relative = path.relative(command.rootDir, batchPath);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw Object.assign(new Error("<batch-file> must stay within the selected repository."), {
      code: "invalid_field",
    });
  try {
    return readFileSync(batchPath, "utf8");
  } catch (error) {
    throw new Error(`Could not read batch declaration: ${cliErrorMessage(error)}`);
  }
}

import { cliErrorMessage } from "./cli-error.ts";
import type { ThinCommand } from "./cli/thin-command.ts";
import { readFileSync } from "node:fs";
import path from "node:path";

/** The batch declaration's parse and execution contract lives in the daemon; the transport only
 * hands the declared document across verbatim. */
export function readRuntimeBatchFile(command: ThinCommand): string {
  try {
    return readFileSync(path.resolve(command.rootDir, String(command.action.batchFile)), "utf8");
  } catch (error) {
    throw new Error(`Could not read batch declaration: ${cliErrorMessage(error)}`);
  }
}

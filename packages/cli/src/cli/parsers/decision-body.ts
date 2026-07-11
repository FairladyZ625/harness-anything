import { readFileSync } from "node:fs";
import path from "node:path";
import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption } from "../parse-options.ts";
import type { CliResult } from "../types.ts";

export function readDecisionBody(
  args: ReadonlyArray<string>,
  inlineBody: string | undefined,
  inputBodyFile?: string
): { readonly ok: true; readonly value: string | undefined } | { readonly ok: false; readonly error: CliResult["error"] } {
  const bodyFile = readOption(args, "--body-file") ?? inputBodyFile;
  if (inlineBody !== undefined && bodyFile !== undefined) {
    return { ok: false, error: cliError(CliErrorCode.ConflictingDecisionBodyInput, "Use only one of --body or --body-file.") };
  }
  if (bodyFile === undefined) return { ok: true, value: inlineBody };
  if (!bodyFile || bodyFile.startsWith("--")) {
    return { ok: false, error: cliError(CliErrorCode.DecisionBodyFileReadFailed, "Use --body-file <path>.") };
  }
  try {
    return { ok: true, value: readFileSync(path.resolve(process.cwd(), bodyFile), "utf8") };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: cliError(CliErrorCode.DecisionBodyFileReadFailed, `Could not read decision body file ${bodyFile}: ${reason}`) };
  }
}

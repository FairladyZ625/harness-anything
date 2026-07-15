import path from "node:path";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import type { PresetPolicyResolution } from "./preset-policy.ts";
import type { ResolvedScriptEntry } from "./script-host.ts";

export function validateResolvedScript(script: ResolvedScriptEntry): { readonly ok: true } | { readonly ok: false; readonly hint: string } {
  const entry = script.entry;
  if (entry.type !== "script") return { ok: false, hint: "Script entry type must be script." };
  if (!entry.id || !entry.command) return { ok: false, hint: "Script entry id and command are required." };
  if (!["user", "vertical", "preset"].includes(entry.source)) return { ok: false, hint: "Script source is invalid." };
  if (entry.metadata.contractVersion !== "script-entry/v1") return { ok: false, hint: "Script metadata contractVersion must be script-entry/v1." };
  if (!entry.metadata.description || !entry.metadata.purpose || !Array.isArray(entry.metadata.produces)) {
    return { ok: false, hint: "Script metadata description, purpose, and produces are required." };
  }
  if (entry.metadata.kind !== undefined && !["action", "check"].includes(entry.metadata.kind)) {
    return { ok: false, hint: "Script metadata kind must be action or check." };
  }
  return { ok: true };
}

export function invalidScriptOrPolicy(
  command: string,
  validation: { readonly ok: true } | { readonly ok: false; readonly hint: string },
  policy: PresetPolicyResolution
): { readonly ok: false; readonly result: CliResult } {
  if (!validation.ok) return scriptFailure(command, CliErrorCode.ScriptContractInvalid, validation.hint);
  if (!policy.ok) return scriptFailure(command, CliErrorCode.PresetPolicyInvalid, policy.error.hint);
  throw new Error("Script and policy validation unexpectedly succeeded.");
}

export function scriptFailure(
  command: string,
  failureCode: CliErrorCode,
  hint: string,
  runDir?: string,
  rootDir?: string
): { readonly ok: false; readonly result: CliResult } {
  return {
    ok: false,
    result: {
      ok: false,
      command,
      evidenceBundle: runDir && rootDir ? path.relative(rootDir, runDir).split(path.sep).join("/") : undefined,
      error: cliError(failureCode, hint)
    }
  };
}

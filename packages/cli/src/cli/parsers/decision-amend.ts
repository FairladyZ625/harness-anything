import {
  decisionAmendFieldSupportsOperation,
  isDecisionAmendField
} from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption, readRepeatedRawOption } from "../parse-options.ts";
import type { CliResult, DecisionAmendPatchInput } from "../types.ts";

export function parseDecisionAmendPatches(args: ReadonlyArray<string>):
  | { readonly ok: true; readonly value: ReadonlyArray<DecisionAmendPatchInput> }
  | { readonly ok: false; readonly error: CliResult["error"] } {
  const patches: DecisionAmendPatchInput[] = [];
  const loadBearingClaimId = readOption(args, "--load-bearing");
  const nonLoadBearingClaimId = readOption(args, "--non-load-bearing");
  if (loadBearingClaimId && nonLoadBearingClaimId) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionAmendPatch, "Use only one of --load-bearing or --non-load-bearing for decision amend.") };
  }
  if (loadBearingClaimId) patches.push(loadBearingPatch(loadBearingClaimId, true));
  if (nonLoadBearingClaimId) patches.push(loadBearingPatch(nonLoadBearingClaimId, false));
  for (const value of readRepeatedRawOption(args, "--set")) {
    const parsed = parseDecisionAmendPatch("replace", value);
    if (!parsed.ok) return parsed;
    patches.push(parsed.value);
  }
  for (const value of readRepeatedRawOption(args, "--append")) {
    const parsed = parseDecisionAmendPatch("append", value);
    if (!parsed.ok) return parsed;
    patches.push(parsed.value);
  }
  return { ok: true, value: patches };
}

function loadBearingPatch(claimId: string, loadBearing: boolean): DecisionAmendPatchInput {
  return {
    field: "claims",
    operation: "metadata",
    value: JSON.stringify({ id: claimId, load_bearing: loadBearing })
  };
}

function parseDecisionAmendPatch(operation: DecisionAmendPatchInput["operation"], value: string | undefined):
  | { readonly ok: true; readonly value: DecisionAmendPatchInput }
  | { readonly ok: false; readonly error: CliResult["error"] } {
  if (!value || value.startsWith("--")) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionAmendPatch, "Use decision amend --set <field>:<value> or --append <field>:<json>.") };
  }
  const separator = value.indexOf(":");
  if (separator <= 0) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionAmendPatch, "Use decision amend --set <field>:<value> or --append <field>:<json>.") };
  }
  const field = value.slice(0, separator).trim();
  const patchValue = value.slice(separator + 1).trim();
  if (!isDecisionAmendField(field) || !decisionAmendFieldSupportsOperation(field, operation)) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionAmendPatch, `decision field is not ${operation}-amendable: ${field}`) };
  }
  if (!patchValue) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionAmendPatch, `decision amend patch value is empty for field: ${field}`) };
  }
  return { ok: true, value: { field, operation, value: patchValue } };
}

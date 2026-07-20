import { DEFAULT_HUMAN_CONSENT_ACTIONS } from "@harness-anything/application";
import { consentActions, type ConsentAction } from "@harness-anything/kernel";
import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption, readRepeatedRawOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseTaskConsentRecord(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const executionId = readOption(args, "--execution-id");
  const utterance = readOption(args, "--utterance");
  const standingPolicyDecisionId = readOption(args, "--standing-policy");
  const assertedRationale = readOption(args, "--asserted");
  const sourceCount = [utterance, standingPolicyDecisionId, assertedRationale].filter(Boolean).length;
  if (!executionId || sourceCount !== 1) {
    return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, "task consent-record requires --execution-id and exactly one of --utterance, --standing-policy, or --asserted.") };
  }
  const actions = parseConsentActions(args);
  if (!actions.ok) return actions;
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: "task-consent-record",
        taskId: args[2],
        executionId,
        ...(utterance ? { utterance } : {}),
        ...(standingPolicyDecisionId ? { standingPolicyDecisionId } : {}),
        ...(assertedRationale ? { assertedRationale } : {}),
        consentActions: actions.value ?? DEFAULT_HUMAN_CONSENT_ACTIONS
      }
    }
  };
}

export function parseConsentActions(args: ReadonlyArray<string>):
  | { readonly ok: true; readonly value?: ReadonlyArray<ConsentAction> }
  | { readonly ok: false; readonly error: CliResult["error"] } {
  const values = readRepeatedRawOption(args, "--consent-action").filter((value): value is string => value !== undefined);
  if (values.length === 0) return { ok: true };
  const invalid = values.find((value) => !(consentActions as ReadonlyArray<string>).includes(value));
  if (invalid) {
    return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, `Unknown consent action: ${invalid}. Valid actions: ${consentActions.join(", ")}.`) };
  }
  if (!values.includes("approve_execution") || new Set(values).size !== values.length) {
    return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, "Consent scope must include approve_execution exactly once; complete_task is optional.") };
  }
  return { ok: true, value: values as ReadonlyArray<ConsentAction> };
}

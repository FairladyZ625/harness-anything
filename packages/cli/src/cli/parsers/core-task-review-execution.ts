import { consentActions as validConsentActions, reviewVerdicts, type ConsentAction } from "@harness-anything/kernel";
import { cliError, CliErrorCode } from "../error-codes.ts";
import type { CommandJsonInput } from "../json-input.ts";
import { readOption, readRepeatedRawOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";
import { parseConsentActions } from "./core-task-consent.ts";
import { jsonBoolean, jsonPayloadFor, jsonStringList, payloadFallback } from "./json-values.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseTaskReviewExecution(args: ReadonlyArray<string>, rootDir: string, json: boolean, input?: CommandJsonInput): ParseResult {
  const payload = jsonPayloadFor(input, "task-review-execution");
  const executionId = payloadFallback(readOption(args, "--execution-id"), payload, "executionId");
  const verdict = payloadFallback(readOption(args, "--verdict"), payload, "verdict");
  const findings = payloadFallback(readOption(args, "--findings"), payload, "findings");
  const rationale = payloadFallback(readOption(args, "--rationale"), payload, "rationale");
  const consentId = payloadFallback(readOption(args, "--consent"), payload, "consentId");
  const consentUtterance = payloadFallback(readOption(args, "--consent-utterance"), payload, "consentUtterance");
  const consentStandingPolicyDecisionId = payloadFallback(readOption(args, "--consent-standing-policy"), payload, "consentStandingPolicyDecisionId");
  const consentAssertedRationale = payloadFallback(readOption(args, "--consent-asserted"), payload, "consentAssertedRationale");
  if ((!executionId && !payload) || !verdict || !findings) {
    return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, "task review-execution requires --execution-id, --verdict, --findings, and --rationale.") };
  }
  if (!(reviewVerdicts as ReadonlyArray<string>).includes(verdict)) {
    return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, `Unknown Review verdict: ${verdict}. Valid verdicts: ${reviewVerdicts.join(", ")}.`) };
  }
  if (!rationale) return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, "task review-execution requires --rationale.") };
  const consentSourceCount = [consentUtterance, consentStandingPolicyDecisionId, consentAssertedRationale].filter(Boolean).length;
  if ((consentId ? 1 : 0) + consentSourceCount > 1) {
    return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, "Use either --consent or exactly one of --consent-utterance, --consent-standing-policy, or --consent-asserted.") };
  }
  const consentActions = parseReviewConsentActions(args, payload?.consentActions);
  if (!consentActions.ok) return consentActions;
  if (consentActions.value && consentSourceCount === 0) {
    return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, "--consent-action requires an explicit consent source declaration.") };
  }
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: "task-review-execution",
        taskId: args[2],
        ...(executionId ? { executionId } : {}),
        verdict: verdict as (typeof reviewVerdicts)[number],
        findings,
        evidenceChecked: repeatedOrPayload(args, "--evidence-checked", jsonStringList(payload, "evidenceChecked")),
        rationale,
        archiveWarningsAcknowledged: args.includes("--acknowledge-archive-warnings") || jsonBoolean(payload, "archiveWarningsAcknowledged"),
        ...(consentId ? { consentId } : {}),
        ...(consentUtterance ? { consentUtterance } : {}),
        ...(consentStandingPolicyDecisionId ? { consentStandingPolicyDecisionId } : {}),
        ...(consentAssertedRationale ? { consentAssertedRationale } : {}),
        ...(consentActions.value ? { consentActions: consentActions.value } : {})
      }
    }
  };
}

function repeatedOrPayload(args: ReadonlyArray<string>, flag: string, payload: ReadonlyArray<string>): ReadonlyArray<string> {
  const flags = readRepeatedRawOption(args, flag).filter((value): value is string => value !== undefined);
  return flags.length > 0 ? flags : payload;
}

function parseReviewConsentActions(args: ReadonlyArray<string>, payload: unknown): ReturnType<typeof parseConsentActions> {
  const fromFlags = parseConsentActions(args);
  if (!fromFlags.ok || fromFlags.value || payload === undefined) return fromFlags;
  if (!Array.isArray(payload) || payload.some((entry) => typeof entry !== "string")) {
    return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, "Review field consentActions must be an array of consent action strings.") };
  }
  const invalid = payload.find((entry) => !(validConsentActions as ReadonlyArray<string>).includes(entry));
  if (invalid) return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, `Unknown consent action: ${invalid}. Valid actions: ${validConsentActions.join(", ")}.`) };
  if (!payload.includes("approve_execution") || new Set(payload).size !== payload.length) {
    return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, "Consent scope must include approve_execution exactly once; complete_task is optional.") };
  }
  return { ok: true, value: payload as ReadonlyArray<ConsentAction> };
}

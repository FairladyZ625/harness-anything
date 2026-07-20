import { consentActions as validConsentActions, reviewVerdicts, type ConsentAction } from "@harness-anything/kernel";
import { cliError, CliErrorCode } from "../error-codes.ts";
import type { CommandJsonInput } from "../json-input.ts";
import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";
import { jsonPayloadFor } from "./json-values.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

const submissionListFields = ["deliverables", "outputs", "verificationNotes", "knownGaps", "residualRisks"] as const;

export function parseTaskStart(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const ttlValue = readOption(args, "--ttl-ms");
  const ttlMs = ttlValue === undefined ? undefined : Number(ttlValue);
  if (ttlMs !== undefined && (!Number.isInteger(ttlMs) || ttlMs <= 0)) {
    return lifecycleFacadeParseFailure("task start --ttl-ms must be a positive integer.");
  }
  return lifecycleFacadeParseSuccess(rootDir, json, {
    kind: "task-start",
    taskId: args[2]!,
    ...(ttlMs === undefined ? {} : { ttlMs }),
    ...(readOption(args, "--execution-id") ? { executionId: readOption(args, "--execution-id") } : {}),
    dryRun: args.includes("--dry-run")
  });
}

export function parseTaskCloseout(
  args: ReadonlyArray<string>,
  rootDir: string,
  json: boolean,
  input?: CommandJsonInput
): ParseResult {
  const payload = jsonPayloadFor(input, "task-closeout");
  if (!payload) return lifecycleFacadeParseFailure("task closeout requires --from-file <closeout.json>.");
  const completionClaim = requiredCloseoutText(payload.completionClaim, "Closeout field completionClaim");
  if (!completionClaim.ok) return completionClaim;
  const verdict = requiredCloseoutText(payload.verdict, "Closeout field verdict");
  if (!verdict.ok) return verdict;
  if (!(reviewVerdicts as ReadonlyArray<string>).includes(verdict.value)) {
    return lifecycleFacadeParseFailure(`Unknown Review verdict: ${verdict.value}. Valid verdicts: ${reviewVerdicts.join(", ")}.`);
  }
  const findings = requiredCloseoutText(payload.findings, "Closeout field findings");
  if (!findings.ok) return findings;
  const rationale = requiredCloseoutText(payload.rationale, "Closeout field rationale");
  if (!rationale.ok) return rationale;
  for (const field of submissionListFields) {
    if (payload[field] !== undefined && !isCloseoutStringArray(payload[field])) return lifecycleFacadeParseFailure(`Closeout field ${field} must be an array of strings.`);
  }
  if (payload.evidenceChecked !== undefined && !isCloseoutStringArray(payload.evidenceChecked)) {
    return lifecycleFacadeParseFailure("Closeout field evidenceChecked must be an array of strings.");
  }
  if (payload.paths !== undefined && !isCloseoutStringArray(payload.paths)) {
    return lifecycleFacadeParseFailure("Closeout field paths must be an array of repository-relative paths.");
  }
  const ciGate = payload.ci;
  if (ciGate !== "passed" && ciGate !== "failed") return lifecycleFacadeParseFailure("Closeout field ci must be passed or failed.");
  const consent = parseConsent(payload, verdict.value);
  if (!consent.ok) return consent;
  const executionId = textOverride(readOption(args, "--execution-id"), payload.executionId);
  const leaseToken = textOverride(readOption(args, "--lease-token"), payload.leaseToken);
  const commitRef = textOverride(readOption(args, "--commit"), payload.commit) ?? "HEAD";
  const reviewerId = textOverride(readOption(args, "--reviewer"), payload.reviewerId) ?? "local-reviewer";
  return lifecycleFacadeParseSuccess(rootDir, json, {
    kind: "task-closeout",
    taskId: args[2]!,
    submission: {
      completionClaim: completionClaim.value,
      deliverables: closeoutStringList(payload.deliverables),
      outputs: closeoutStringList(payload.outputs),
      verificationNotes: closeoutStringList(payload.verificationNotes),
      knownGaps: closeoutStringList(payload.knownGaps),
      residualRisks: closeoutStringList(payload.residualRisks)
    },
    review: {
      ...(executionId ? { executionId } : {}),
      verdict: verdict.value as (typeof reviewVerdicts)[number],
      findings: findings.value,
      evidenceChecked: closeoutStringList(payload.evidenceChecked),
      rationale: rationale.value,
      archiveWarningsAcknowledged: payload.archiveWarningsAcknowledged === true,
      ...consent.value
    },
    ...(executionId ? { executionId } : {}),
    ...(leaseToken ? { leaseToken } : {}),
    commitRef,
    paths: closeoutStringList(payload.paths),
    ...(typeof payload.prRef === "string" ? { prRef: payload.prRef } : {}),
    forceCodeDoc: payload.forceCodeDoc === true,
    ciGate,
    reviewerId,
    dryRun: args.includes("--dry-run")
  });
}

function parseConsent(payload: Readonly<Record<string, unknown>>, verdict: string):
  | { readonly ok: true; readonly value: Pick<Extract<ParsedCommand["action"], { readonly kind: "task-closeout" }>["review"], "consentId" | "consentUtterance" | "consentStandingPolicyDecisionId" | "consentAssertedRationale" | "consentActions"> }
  | { readonly ok: false; readonly error: CliResult["error"] } {
  const consentId = optionalText(payload.consentId);
  const consentUtterance = optionalText(payload.consentUtterance);
  const consentStandingPolicyDecisionId = optionalText(payload.consentStandingPolicyDecisionId);
  const consentAssertedRationale = optionalText(payload.consentAssertedRationale);
  const consentSourceCount = [consentId, consentUtterance, consentStandingPolicyDecisionId, consentAssertedRationale].filter(Boolean).length;
  if (consentSourceCount > 1) {
    return lifecycleFacadeParseFailure("Closeout review accepts either consentId or exactly one consent source declaration.");
  }
  if (verdict === "approved" && consentSourceCount !== 1) {
    return lifecycleFacadeParseFailure("An approved closeout requires exactly one consent source: consentId, consentUtterance, consentStandingPolicyDecisionId, or consentAssertedRationale.");
  }
  if (payload.consentActions !== undefined && (!isCloseoutStringArray(payload.consentActions) || payload.consentActions.some((entry) => !(validConsentActions as ReadonlyArray<string>).includes(entry)))) {
    return lifecycleFacadeParseFailure(`Closeout field consentActions must contain only: ${validConsentActions.join(", ")}.`);
  }
  const consentActions = payload.consentActions as ReadonlyArray<ConsentAction> | undefined;
  if (consentActions && (!consentActions.includes("approve_execution") || new Set(consentActions).size !== consentActions.length)) {
    return lifecycleFacadeParseFailure("Consent scope must include approve_execution exactly once; complete_task is optional.");
  }
  if (consentActions && !consentUtterance && !consentStandingPolicyDecisionId && !consentAssertedRationale) {
    return lifecycleFacadeParseFailure("consentActions requires an explicit consent source declaration.");
  }
  return { ok: true, value: {
    ...(consentId ? { consentId } : {}),
    ...(consentUtterance ? { consentUtterance } : {}),
    ...(consentStandingPolicyDecisionId ? { consentStandingPolicyDecisionId } : {}),
    ...(consentAssertedRationale ? { consentAssertedRationale } : {}),
    ...(consentActions ? { consentActions } : {})
  } };
}

function requiredCloseoutText(value: unknown, label: string): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: CliResult["error"] } {
  return typeof value === "string" && value.trim() ? { ok: true, value } : lifecycleFacadeParseFailure(`${label} must be a non-empty string.`);
}

function textOverride(flag: string | undefined, payload: unknown): string | undefined {
  return flag ?? optionalText(payload);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function closeoutStringList(value: unknown): ReadonlyArray<string> {
  return isCloseoutStringArray(value) ? value : [];
}

function isCloseoutStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function lifecycleFacadeParseSuccess(rootDir: string, json: boolean, action: ParsedCommand["action"]): ParseResult {
  return { ok: true, value: { rootDir, json, action } };
}

function lifecycleFacadeParseFailure(hint: string): { readonly ok: false; readonly error: CliResult["error"] } {
  return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, hint) };
}

import { consentActions as validConsentActions, type ConsentAction } from "@harness-anything/kernel";
import { cliError, CliErrorCode } from "../error-codes.ts";
import type { CommandJsonInput } from "../json-input.ts";
import { readOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";
import { jsonPayloadFor } from "./json-values.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

export function parseTaskComplete(
  args: ReadonlyArray<string>,
  rootDir: string,
  json: boolean,
  input?: CommandJsonInput
): ParseResult {
  const legacyCommitRef = readOption(args, "--commit-anchor");
  const judgment = readOption(args, "--judgment");
  if (args.includes("--approve") && (legacyCommitRef !== undefined || judgment !== undefined)) {
    return taskCompleteFailure("Choose one owner approval mode: use --approve --from-file <approval.json>, or the compatibility --commit-anchor <ref> --judgment <reason> pair, not both.");
  }
  if (legacyCommitRef || judgment) return parseCommitAnchorApproval(args, rootDir, json, legacyCommitRef, judgment);
  if (!args.includes("--approve")) {
    return parseReviewedExecutionCompatibility(args, rootDir, json);
  }
  const payload = jsonPayloadFor(input, "task-complete");
  if (!payload) return taskCompleteFailure("task complete --approve requires --from-file <approval.json>.");
  const findings = requiredText(payload.findings, "Approval field findings");
  if (!findings.ok) return findings;
  const rationale = requiredText(payload.rationale, "Approval field rationale");
  if (!rationale.ok) return rationale;
  if (payload.evidenceChecked !== undefined && !isTaskCompleteStringArray(payload.evidenceChecked)) {
    return taskCompleteFailure("Approval field evidenceChecked must be an array of strings.");
  }
  if (payload.paths !== undefined && !isTaskCompleteStringArray(payload.paths)) {
    return taskCompleteFailure("Approval field paths must be an array of repository-relative strings.");
  }
  const consent = parseTaskCompleteConsent(payload);
  if (!consent.ok) return consent;
  const ciGate = readOption(args, "--ci") ?? taskCompleteOptionalText(payload.ci);
  if (ciGate !== undefined && ciGate !== "passed" && ciGate !== "failed" && ciGate !== "not-applicable") {
    return { ok: false, error: cliError(CliErrorCode.InvalidCiGate, `Unknown CI gate: ${ciGate}. Valid CI gate values: passed, failed, not-applicable.`) };
  }
  const executionId = readOption(args, "--execution-id") ?? taskCompleteOptionalText(payload.executionId);
  const commitRef = readOption(args, "--commit") ?? taskCompleteOptionalText(payload.commit) ?? "HEAD";
  const reviewerId = readOption(args, "--reviewer") ?? taskCompleteOptionalText(payload.reviewerId) ?? "local-reviewer";
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: "task-complete",
        taskId: args[1]!,
        ...(ciGate ? { ciGate } : {}),
        reviewerId,
        evidenceMode: "execution-review",
        commitRef,
        approval: {
          ...(executionId ? { executionId } : {}),
          findings: findings.value,
          evidenceChecked: taskCompleteStringList(payload.evidenceChecked),
          rationale: rationale.value,
          archiveWarningsAcknowledged: payload.archiveWarningsAcknowledged === true,
          ...consent.value,
          paths: taskCompleteStringList(payload.paths),
          ...(typeof payload.prRef === "string" ? { prRef: payload.prRef } : {})
        },
        dryRun: args.includes("--dry-run")
      }
    }
  };
}

function parseReviewedExecutionCompatibility(
  args: ReadonlyArray<string>,
  rootDir: string,
  json: boolean
): ParseResult {
  const ciGate = readOption(args, "--ci");
  if (ciGate !== undefined && ciGate !== "passed" && ciGate !== "failed" && ciGate !== "not-applicable") {
    return { ok: false, error: cliError(CliErrorCode.InvalidCiGate, `Unknown CI gate: ${ciGate}. Valid CI gate values: passed, failed, not-applicable.`) };
  }
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: "task-complete",
        taskId: args[1]!,
        ...(ciGate ? { ciGate } : {}),
        reviewerId: readOption(args, "--reviewer") ?? "local-reviewer",
        evidenceMode: "execution-review"
      }
    }
  };
}

function parseCommitAnchorApproval(
  args: ReadonlyArray<string>,
  rootDir: string,
  json: boolean,
  commitRef: string | undefined,
  judgment: string | undefined
): ParseResult {
  if (Boolean(commitRef) !== Boolean(judgment)) {
    return { ok: false, error: cliError(CliErrorCode.CompletionEvidenceModeInvalid, "Use --commit-anchor and --judgment together.") };
  }
  if (args.includes("--reviewer")) {
    return { ok: false, error: cliError(CliErrorCode.CompletionEvidenceModeInvalid, "Commit-anchor approval records the authenticated judge; --reviewer belongs only to --approve completion.") };
  }
  const ciGate = readOption(args, "--ci");
  if (ciGate !== undefined && ciGate !== "passed" && ciGate !== "failed" && ciGate !== "not-applicable") {
    return { ok: false, error: cliError(CliErrorCode.InvalidCiGate, `Unknown CI gate: ${ciGate}. Valid CI gate values: passed, failed, not-applicable.`) };
  }
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: "task-complete",
        taskId: args[1]!,
        ...(ciGate ? { ciGate } : {}),
        reviewerId: "local-reviewer",
        evidenceMode: "commit-anchor",
        commitRef: commitRef!,
        judgment,
        dryRun: args.includes("--dry-run")
      }
    }
  };
}

function parseTaskCompleteConsent(payload: Readonly<Record<string, unknown>>):
  | { readonly ok: true; readonly value: Pick<NonNullable<Extract<ParsedCommand["action"], { readonly kind: "task-complete" }>["approval"]>, "consentId" | "consentUtterance" | "consentStandingPolicyDecisionId" | "consentAssertedRationale" | "consentActions"> }
  | { readonly ok: false; readonly error: CliResult["error"] } {
  const consentId = taskCompleteOptionalText(payload.consentId);
  const consentUtterance = taskCompleteOptionalText(payload.consentUtterance);
  const consentStandingPolicyDecisionId = taskCompleteOptionalText(payload.consentStandingPolicyDecisionId);
  const consentAssertedRationale = taskCompleteOptionalText(payload.consentAssertedRationale);
  const consentSourceCount = [consentId, consentUtterance, consentStandingPolicyDecisionId, consentAssertedRationale].filter(Boolean).length;
  if (consentSourceCount !== 1) {
    return taskCompleteFailure("Owner approval requires exactly one consent source: consentId, consentUtterance, consentStandingPolicyDecisionId, or consentAssertedRationale.");
  }
  if (payload.consentActions !== undefined && (!isTaskCompleteStringArray(payload.consentActions)
    || payload.consentActions.some((entry) => !(validConsentActions as ReadonlyArray<string>).includes(entry)))) {
    return taskCompleteFailure(`Approval field consentActions must contain only: ${validConsentActions.join(", ")}.`);
  }
  const consentActions = payload.consentActions as ReadonlyArray<ConsentAction> | undefined;
  if (consentActions && (!consentActions.includes("approve_execution")
    || !consentActions.includes("complete_task")
    || new Set(consentActions).size !== consentActions.length)) {
    return taskCompleteFailure("Owner approval consent scope must include approve_execution and complete_task exactly once.");
  }
  if (consentActions && consentId) return taskCompleteFailure("consentActions is only valid when creating consent from an explicit source declaration.");
  return { ok: true, value: {
    ...(consentId ? { consentId } : {}),
    ...(consentUtterance ? { consentUtterance } : {}),
    ...(consentStandingPolicyDecisionId ? { consentStandingPolicyDecisionId } : {}),
    ...(consentAssertedRationale ? { consentAssertedRationale } : {}),
    ...(consentActions ? { consentActions } : {})
  } };
}

function requiredText(value: unknown, label: string): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: CliResult["error"] } {
  return typeof value === "string" && value.trim() ? { ok: true, value } : taskCompleteFailure(`${label} must be a non-empty string.`);
}

function taskCompleteOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function taskCompleteStringList(value: unknown): ReadonlyArray<string> {
  return isTaskCompleteStringArray(value) ? value : [];
}

function isTaskCompleteStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function taskCompleteFailure(hint: string): { readonly ok: false; readonly error: CliResult["error"] } {
  return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, hint) };
}

import { cliError, CliErrorCode } from "../error-codes.ts";
import type { CommandJsonInput } from "../json-input.ts";
import type { CliResult, ParsedCommand } from "../types.ts";
import { jsonPayloadFor } from "./json-values.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

const submissionListFields = ["deliverables", "outputs", "verificationNotes", "knownGaps", "residualRisks"] as const;

export function parseTaskSubmit(
  args: ReadonlyArray<string>,
  rootDir: string,
  json: boolean,
  input?: CommandJsonInput
): ParseResult {
  const payload = jsonPayloadFor(input, "task-submit");
  if (!payload) return taskSubmitFailure("task submit requires --from-file <submission.json>.");
  const completionClaim = payload.completionClaim;
  if (typeof completionClaim !== "string" || completionClaim.trim().length === 0) {
    return taskSubmitFailure("Submission field completionClaim must be a non-empty string.");
  }
  for (const field of submissionListFields) {
    if (!isStringArray(payload[field])) return taskSubmitFailure(`Submission field ${field} must be an array of strings.`);
  }
  const codeDoc = parseCodeDoc(payload.codeDoc);
  if (!codeDoc.ok) return codeDoc;
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: "task-submit",
        taskId: args[2]!,
        submission: {
          completionClaim,
          deliverables: payload.deliverables as ReadonlyArray<string>,
          outputs: payload.outputs as ReadonlyArray<string>,
          verificationNotes: payload.verificationNotes as ReadonlyArray<string>,
          knownGaps: payload.knownGaps as ReadonlyArray<string>,
          residualRisks: payload.residualRisks as ReadonlyArray<string>
        },
        ...(typeof payload.executionId === "string" ? { executionId: payload.executionId } : {}),
        ...(typeof payload.leaseToken === "string" ? { leaseToken: payload.leaseToken } : {}),
        ...(codeDoc.value ? { codeDoc: codeDoc.value } : {}),
        dryRun: args.includes("--dry-run")
      }
    }
  };
}

function parseCodeDoc(value: unknown):
  | { readonly ok: true; readonly value?: { readonly sha: string; readonly paths: ReadonlyArray<string>; readonly prRef?: string; readonly force: boolean } }
  | { readonly ok: false; readonly error: CliResult["error"] } {
  if (value === undefined) return { ok: true };
  if (!isSubmissionRecord(value)) return taskSubmitFailure("Submission field codeDoc must be an object.");
  if (typeof value.commit !== "string" || !/^[0-9a-f]{40}$/u.test(value.commit)) {
    return taskSubmitFailure("Submission codeDoc.commit must be a full 40-character commit sha.");
  }
  if (!isStringArray(value.paths)) return taskSubmitFailure("Submission codeDoc.paths must be an array of repository-relative paths.");
  if (value.prRef !== undefined && typeof value.prRef !== "string") return taskSubmitFailure("Submission codeDoc.prRef must be a string.");
  if (value.force !== undefined && typeof value.force !== "boolean") return taskSubmitFailure("Submission codeDoc.force must be a boolean.");
  return {
    ok: true,
    value: {
      sha: value.commit,
      paths: value.paths,
      ...(typeof value.prRef === "string" ? { prRef: value.prRef } : {}),
      force: value.force === true
    }
  };
}

function taskSubmitFailure(hint: string): { readonly ok: false; readonly error: CliResult["error"] } {
  return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, hint) };
}

function isSubmissionRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

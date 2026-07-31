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
  if (!payload) {
    return taskSubmitFailure(
      `Received task submit ${args[2]} without a submission packet. Expected --from-file <submission.json>. Next: run \`ha task submit ${args[2]} --from-file submission.json\`.`
    );
  }
  const completionClaim = payload.completionClaim;
  if (typeof completionClaim !== "string" || completionClaim.trim().length === 0) {
    return taskSubmitFailure("Submission field completionClaim must be a non-empty string.");
  }
  for (const field of submissionListFields) {
    if (!isStringArray(payload[field])) return taskSubmitFailure(`Submission field ${field} must be an array of strings.`);
  }
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
        dryRun: args.includes("--dry-run")
      }
    }
  };
}

function taskSubmitFailure(hint: string): { readonly ok: false; readonly error: CliResult["error"] } {
  return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, hint) };
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

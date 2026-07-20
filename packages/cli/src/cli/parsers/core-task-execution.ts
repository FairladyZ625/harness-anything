import type { DomainStatus } from "@harness-anything/kernel";
import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption, readRepeatedRawOption, readRequiredValueOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type Submission = Extract<ParsedCommand["action"], { readonly kind: "status-set" }>["executionSubmission"];

export function parseTaskClaim(args: ReadonlyArray<string>, rootDir: string, json: boolean) {
  const executionId = readRequiredValueOption(args, "--execution-id");
  if (!executionId.ok) return executionId;
  const ttlValue = readOption(args, "--ttl-ms");
  let ttlMs: number | undefined;
  if (ttlValue !== undefined) {
    ttlMs = Number(ttlValue);
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      return { ok: false as const, error: cliError(CliErrorCode.InvalidTaskMetadata, "Use --ttl-ms with a positive integer.") };
    }
  }
  return { ok: true as const, value: {
    rootDir,
    json,
    action: {
      kind: "task-claim" as const,
      taskId: args[2]!,
      execution: args.includes("--execution") || executionId.value !== undefined,
      ...(executionId.value ? { executionId: executionId.value } : {}),
      ...(ttlMs !== undefined ? { ttlMs } : {})
    }
  } };
}

export function parseExecutionSubmissionOptions(args: ReadonlyArray<string>, status: DomainStatus):
  | { readonly ok: true; readonly value?: Submission }
  | { readonly ok: false; readonly error: CliResult["error"] } {
  const executionId = readOption(args, "--execution-id");
  const leaseToken = readOption(args, "--lease-token");
  const completionClaim = readOption(args, "--completion-claim") ?? readOption(args, "--summary");
  if (![executionId, leaseToken, completionClaim].some(Boolean)) return { ok: true };
  if (!completionClaim || status !== "in_review") {
    return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, "Execution submit requires in_review plus --completion-claim; --execution-id and --lease-token are optional when Holder V2 is active for the caller.") };
  }
  const values = (flag: string) => readRepeatedRawOption(args, flag).filter((value): value is string => value !== undefined);
  return { ok: true, value: {
    ...(executionId ? { executionId } : {}),
    ...(leaseToken ? { leaseToken } : {}),
    completionClaim,
    deliverables: values("--deliverable"),
    verificationNotes: values("--verification"),
    knownGaps: values("--known-gap"),
    residualRisks: values("--residual-risk"),
    outputs: values("--output")
  } };
}

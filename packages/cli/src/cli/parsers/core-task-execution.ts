import type { DomainStatus } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption, readRepeatedRawOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type Submission = Extract<ParsedCommand["action"], { readonly kind: "status-set" }>["executionSubmission"];

export function parseExecutionSubmissionOptions(args: ReadonlyArray<string>, status: DomainStatus):
  | { readonly ok: true; readonly value?: Submission }
  | { readonly ok: false; readonly error: CliResult["error"] } {
  const executionId = readOption(args, "--execution-id");
  const leaseToken = readOption(args, "--lease-token");
  const summary = readOption(args, "--summary");
  if (![executionId, leaseToken, summary].some(Boolean)) return { ok: true };
  if (!leaseToken || !summary || status !== "in_review") {
    return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, "Execution submit requires in_review plus --lease-token and --summary; --execution-id is optional when Holder V2 is active.") };
  }
  const values = (flag: string) => readRepeatedRawOption(args, flag).filter((value): value is string => value !== undefined);
  return { ok: true, value: {
    ...(executionId ? { executionId } : {}),
    leaseToken,
    summary,
    verification: values("--verification"),
    residualRisks: values("--residual-risk"),
    outputs: values("--output")
  } };
}

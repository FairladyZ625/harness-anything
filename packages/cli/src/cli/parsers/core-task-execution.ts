import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption, readRequiredValueOption } from "../parse-options.ts";

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

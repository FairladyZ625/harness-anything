import { cliError, CliErrorCode } from "../error-codes.ts";
import type { CommandJsonInput } from "../json-input.ts";
import { decodeTaskSubmitPacket } from "../task-packet-contracts.ts";
import type { CliResult, ParsedCommand } from "../types.ts";
import { jsonPayloadFor } from "./json-values.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };

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
  const decoded = decodeTaskSubmitPacket(payload);
  if (!decoded.ok) return taskSubmitFailure(decoded.issue);
  const packet = decoded.value;
  return {
    ok: true,
    value: {
      rootDir,
      json,
      action: {
        kind: "task-submit",
        taskId: args[2]!,
        submission: {
          completionClaim: packet.completionClaim,
          deliverables: packet.deliverables,
          outputs: packet.outputs,
          verificationNotes: packet.verificationNotes,
          knownGaps: packet.knownGaps,
          residualRisks: packet.residualRisks
        },
        ...(packet.executionId ? { executionId: packet.executionId } : {}),
        ...(packet.leaseToken ? { leaseToken: packet.leaseToken } : {}),
        dryRun: args.includes("--dry-run")
      }
    }
  };
}

function taskSubmitFailure(hint: string): { readonly ok: false; readonly error: CliResult["error"] } {
  return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, hint) };
}

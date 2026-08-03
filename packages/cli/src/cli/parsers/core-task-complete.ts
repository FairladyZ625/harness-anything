import { cliError, CliErrorCode } from "../error-codes.ts";
import type { CommandJsonInput } from "../json-input.ts";
import { readOption } from "../parse-options.ts";
import { decodeTaskCompleteApprovalPacket } from "../task-packet-contracts.ts";
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
  if (!payload) {
    return taskCompleteFailure(
      `Received task complete ${args[1]} --approve without an approval packet. Expected --from-file <approval.json>. Next: run \`ha task complete ${args[1]} --approve --from-file approval.json\`.`
    );
  }
  const decoded = decodeTaskCompleteApprovalPacket(payload);
  if (!decoded.ok) return taskCompleteFailure(decoded.issue);
  const packet = decoded.value;
  const ciGate = readOption(args, "--ci") ?? packet.ci;
  if (ciGate !== undefined && ciGate !== "passed" && ciGate !== "failed" && ciGate !== "not-applicable") {
    return { ok: false, error: cliError(CliErrorCode.InvalidCiGate, `Unknown CI gate: ${ciGate}. Valid CI gate values: passed, failed, not-applicable.`) };
  }
  const executionId = readOption(args, "--execution-id") ?? packet.executionId;
  const commitRef = readOption(args, "--commit") ?? packet.commit ?? "HEAD";
  const reviewerId = readOption(args, "--reviewer") ?? packet.reviewerId ?? "local-reviewer";
  const externalCheckpointRefs = packet.externalCheckpointRefs ?? [];
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
          findings: packet.findings,
          evidenceChecked: packet.evidenceChecked ?? [],
          rationale: packet.rationale,
          archiveWarningsAcknowledged: packet.archiveWarningsAcknowledged === true,
          ...(packet.consentId ? { consentId: packet.consentId } : {}),
          ...(packet.consentUtterance ? { consentUtterance: packet.consentUtterance } : {}),
          ...(packet.consentStandingPolicyDecisionId
            ? { consentStandingPolicyDecisionId: packet.consentStandingPolicyDecisionId }
            : {}),
          ...(packet.consentAssertedRationale
            ? { consentAssertedRationale: packet.consentAssertedRationale }
            : {}),
          ...(packet.consentActions ? { consentActions: packet.consentActions } : {}),
          paths: packet.paths ?? [],
          ...(packet.prRef ? { prRef: packet.prRef } : {})
        },
        ...(externalCheckpointRefs.length > 0
          ? { externalCheckpointRefs }
          : {}),
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
        evidenceMode: "execution-review",
        dryRun: args.includes("--dry-run")
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
    return taskCompleteFailure("Use --commit-anchor and --judgment together.");
  }
  if (args.includes("--reviewer")) {
    return taskCompleteFailure("Commit-anchor approval records the authenticated judge; --reviewer belongs only to --approve completion.");
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

function taskCompleteFailure(hint: string): { readonly ok: false; readonly error: CliResult["error"] } {
  return { ok: false, error: cliError(CliErrorCode.InvalidTaskMetadata, hint) };
}

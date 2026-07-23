import {
  assertRepoWriteOutcomeAxesV1,
  decodeRepoWriteOutcomeV1,
  type RepoWriteTerminalOutcomeV1
} from "./repo-write-outcome-schema.ts";
import type {
  RepoWriteJsonObject,
  RepoWriteOperationLookupResult,
  RepoWriteTerminalOutcome
} from "./repo-write-protocol.ts";

export type RepoWriteHostedOperationPhase =
  "preparing" | "prepared" | "proceeding" | RepoWriteTerminalOutcome | "failed" | "unknown";

export type RepoWriteCanonicalLookupResult =
  | { readonly state: Exclude<RepoWriteOperationLookupResult["state"], "committed" | "rejected"> }
  | {
      readonly state: "terminal";
      readonly outcome: RepoWriteTerminalOutcomeV1;
    };

export function repoWriteCanonicalLookupResult(
  result: RepoWriteCanonicalLookupResult,
  opId: string,
  axes: {
    readonly repoId: string;
    readonly workspaceId: string;
    readonly generation: number;
  }
): RepoWriteOperationLookupResult {
  if (result.state !== "terminal") return result;
  const outcome = decodeRepoWriteOutcomeV1(result.outcome);
  if (outcome.phase !== "TERMINAL" || outcome.outerOpId !== opId) {
    throw new Error("canonical lookup did not return the matching durable TERMINAL outer outcome");
  }
  assertRepoWriteOutcomeAxesV1(outcome, axes);
  return outcome.terminalKind === "committed"
    ? {
        state: "committed",
        outcome: "committed",
        receipt: outcome.receipt as unknown as RepoWriteJsonObject
      }
    : {
        state: "rejected",
        outcome: "rejected",
        receipt: outcome.receipt as unknown as RepoWriteJsonObject
      };
}

export function repoWriteLocalLookupResult(operation: {
  readonly phase: RepoWriteHostedOperationPhase;
  readonly receipt?: RepoWriteJsonObject;
}): RepoWriteOperationLookupResult {
  if (operation.phase === "preparing" || operation.phase === "prepared") return { state: "prepared" };
  if (operation.phase === "proceeding") return { state: "proceeding" };
  if (operation.phase !== "committed" && operation.phase !== "rejected") {
    return { state: operation.phase };
  }
  if (!operation.receipt) throw new Error("terminal repo writer operation is missing its receipt");
  return operation.phase === "committed"
    ? { state: "committed", outcome: "committed", receipt: operation.receipt }
    : { state: "rejected", outcome: "rejected", receipt: operation.receipt };
}

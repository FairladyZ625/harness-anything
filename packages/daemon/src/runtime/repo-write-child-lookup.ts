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
import type { RepoWriteChildOperationPhase } from "./repo-write-phase.ts";

export type RepoWriteHostedOperationPhase = RepoWriteChildOperationPhase;
export type RepoWriteHostedOperationNonTerminalPhase = Exclude<
  RepoWriteHostedOperationPhase,
  "terminal" | "accepted"
>;

export type RepoWriteHostedOperationSnapshot =
  | { readonly phase: RepoWriteHostedOperationNonTerminalPhase }
  | {
      readonly phase: "accepted";
      readonly receipt: RepoWriteJsonObject;
    }
  | {
      readonly phase: "terminal";
      readonly outcome: RepoWriteTerminalOutcome;
      readonly receipt: RepoWriteJsonObject;
    };

type RepoWriteAssertTrue<Value extends true> = Value;
type RepoWriteTerminalSnapshot = Extract<RepoWriteHostedOperationSnapshot, { phase: "terminal" }>;
type RepoWriteTerminalSnapshotOutcomeIsRequired =
  object extends Pick<RepoWriteTerminalSnapshot, "outcome"> ? false : true;
type _RepoWriteTerminalSnapshotMustCarryOutcome =
  RepoWriteAssertTrue<RepoWriteTerminalSnapshotOutcomeIsRequired>;

export function repoWriteHostedOperationSnapshot(operation: {
  readonly phase: RepoWriteHostedOperationPhase;
  readonly outcome?: RepoWriteTerminalOutcome;
  readonly receipt?: RepoWriteJsonObject;
}): RepoWriteHostedOperationSnapshot {
  if (operation.phase === "terminal") {
    if (operation.outcome === undefined || operation.receipt === undefined) {
      throw new Error("terminal repo writer operation is missing its outcome or receipt");
    }
    return {
      phase: "terminal",
      outcome: operation.outcome,
      receipt: operation.receipt
    };
  }
  if (operation.phase === "accepted") {
    if (operation.receipt === undefined || operation.outcome !== undefined) {
      throw new Error("accepted repo writer operation must carry only its accepted receipt");
    }
    return { phase: "accepted", receipt: operation.receipt };
  }
  if (operation.outcome !== undefined || operation.receipt !== undefined) {
    throw new Error("non-terminal repo writer operation has terminal result data");
  }
  return { phase: operation.phase };
}

export type RepoWriteCanonicalLookupResult =
  | { readonly state: Exclude<RepoWriteOperationLookupResult["state"], "committed" | "rejected" | "accepted" | "settlement-failed"> }
  | { readonly state: "accepted" | "settlement-failed"; readonly receipt: RepoWriteJsonObject }
  | { readonly state: "canonical-visible"; readonly receipt: RepoWriteJsonObject }
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
  if (result.state === "accepted" || result.state === "settlement-failed") return result;
  if (result.state === "canonical-visible") {
    return {
      state: "committed",
      outcome: "committed",
      receipt: result.receipt
    };
  }
  if (result.state !== "terminal") return result;
  const outcome = decodeRepoWriteOutcomeV1(result.outcome);
  if (outcome.phase !== "TERMINAL" || outcome.outerOpId !== opId) {
    throw new Error("canonical lookup did not return the matching durable TERMINAL outer outcome");
  }
  assertRepoWriteOutcomeAxesV1(outcome, {
    ...axes,
    generation: outcome.generation
  });
  if (outcome.generation > axes.generation) {
    throw new Error(
      "canonical lookup returned a terminal outcome from a future writer generation"
    );
  }
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

export function repoWriteLocalLookupResult(
  operation: RepoWriteHostedOperationSnapshot
): RepoWriteOperationLookupResult {
  if (operation.phase === "preparing" || operation.phase === "prepared") return { state: "prepared" };
  if (operation.phase === "proceeding") return { state: "proceeding" };
  if (operation.phase === "accepted") return { state: "accepted", receipt: operation.receipt };
  if (operation.phase !== "terminal") {
    return { state: operation.phase };
  }
  if (operation.outcome === undefined || operation.receipt === undefined) {
    throw new Error("terminal repo writer operation is missing its outcome or receipt");
  }
  return operation.outcome === "committed"
    ? { state: "committed", outcome: "committed", receipt: operation.receipt }
    : { state: "rejected", outcome: "rejected", receipt: operation.receipt };
}

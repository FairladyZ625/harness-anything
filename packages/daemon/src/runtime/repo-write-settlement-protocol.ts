import { decodeRepoWriteCommandReceiptV2 } from "./repo-write-command-receipt.ts";
import type {
  RepoWriteJsonObject,
  RepoWriteOperationFrame,
  RepoWriteTerminalOutcome
} from "./repo-write-protocol.ts";

export interface RepoWriteAcceptedFrame extends RepoWriteOperationFrame<"accepted"> {
  readonly receipt: RepoWriteJsonObject;
}

export type RepoWriteOperationState =
  "not-found" | "prepared" | "proceeding" | "accepted" | "settlement-failed"
  | RepoWriteTerminalOutcome | "failed" | "unknown";

export type RepoWriteOperationLookupResult =
  | { readonly state: Exclude<RepoWriteOperationState, RepoWriteTerminalOutcome | "accepted" | "settlement-failed"> }
  | {
      readonly state: "accepted" | "settlement-failed";
      readonly receipt: RepoWriteJsonObject;
    }
  | {
      readonly state: "committed";
      readonly outcome: "committed";
      readonly receipt: RepoWriteJsonObject;
    }
  | {
      readonly state: "rejected";
      readonly outcome: "rejected";
      readonly receipt: RepoWriteJsonObject;
    };

export const repoWriteOperationStates: ReadonlyArray<RepoWriteOperationState> = [
  "not-found", "prepared", "proceeding", "accepted", "settlement-failed",
  "committed", "rejected", "failed", "unknown"
];

export function receiptSettlementVisibilityMatches(
  receipt: RepoWriteJsonObject,
  path: string,
  visibility: "pending" | "failed"
): boolean {
  try {
    const decoded = decodeRepoWriteCommandReceiptV2(receipt, path);
    return decoded.settlement?.canonicalVisibility === visibility;
  } catch {
    return false;
  }
}

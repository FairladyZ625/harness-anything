import { decodeRepoWriteCommandReceiptV2 } from "./repo-write-command-receipt.ts";
import type {
  RepoWriteJsonObject,
  RepoWriteTerminalOutcome
} from "./repo-write-protocol.ts";

export function repoWriteTerminalReceiptMatches(
  outcome: RepoWriteTerminalOutcome,
  receipt: RepoWriteJsonObject
): boolean {
  try {
    const normalized = decodeRepoWriteCommandReceiptV2(receipt, "$.receipt");
    return (normalized.ok ? "committed" : "rejected") === outcome;
  } catch {
    return false;
  }
}

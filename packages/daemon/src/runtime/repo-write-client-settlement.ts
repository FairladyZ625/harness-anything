import type {
  RepoWriteOperationLookupResult,
  RepoWriteStatusFrame
} from "./repo-write-protocol.ts";

export function repoWriteLookupResultFromStatus(
  message: RepoWriteStatusFrame
): RepoWriteOperationLookupResult {
  if (message.state === "committed") {
    return { state: "committed", outcome: "committed", receipt: message.receipt };
  }
  if (message.state === "rejected") {
    return { state: "rejected", outcome: "rejected", receipt: message.receipt };
  }
  if (message.state === "accepted" || message.state === "settlement-failed") {
    return { state: message.state, receipt: message.receipt };
  }
  return { state: message.state };
}

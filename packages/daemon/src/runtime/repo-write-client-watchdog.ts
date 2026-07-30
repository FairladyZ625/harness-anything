import type { RepoWriteRequestTimeoutDiagnostic } from "./repo-write-client-contract.ts";
import type { PendingSubmit } from "./repo-write-client-pending.ts";
import { escalateRepoWriteSubmitStall } from "./repo-write-client-timeout.ts";

export function armRepoWriteSubmitEscalation(input: {
  readonly pending: PendingSubmit;
  readonly pendingRequests: Map<string, PendingSubmit>;
  readonly delayMs: number;
  readonly totalTimeoutMs: number;
  readonly onTimeout?: (diagnostic: RepoWriteRequestTimeoutDiagnostic) => void;
}): void {
  input.pending.timer = setTimeout(() => {
    if (!input.pendingRequests.delete(input.pending.requestId)) return;
    escalateRepoWriteSubmitStall(input.pending, input.totalTimeoutMs, input.onTimeout);
  }, input.delayMs);
  input.pending.timer.unref();
}

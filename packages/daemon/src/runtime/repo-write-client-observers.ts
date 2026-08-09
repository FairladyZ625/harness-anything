import type {
  RepoWriteRecoveryDiagnosticFrame,
  RepoWriteRetryBudgetSignalFrame,
  RepoWriteTelemetryFrame
} from "./repo-write-protocol.ts";
import { repoWriteProtocolType } from "./repo-write-protocol.ts";

export function repoWriteClientFrameBase(repoId: string, generation: number) {
  return { protocol: repoWriteProtocolType, repoId, generation } as const;
}

export function observeRepoWriteTelemetry(
  observer: (frame: RepoWriteTelemetryFrame) => void,
  frame: RepoWriteTelemetryFrame,
  failProtocol: () => void
): void {
  try {
    observer(frame);
  } catch {
    failProtocol();
  }
}

export function observeRepoWriteRecoveryDiagnostic(
  observer: ((frame: RepoWriteRecoveryDiagnosticFrame) => void) | undefined,
  frame: RepoWriteRecoveryDiagnosticFrame
): void {
  try {
    observer?.(frame);
  } catch {
    // Operational logging cannot change writer protocol or recovery state.
  }
}

export function observeRepoWriteRetryBudgetSignal(
  observer: ((frame: RepoWriteRetryBudgetSignalFrame) => void) | undefined,
  frame: RepoWriteRetryBudgetSignalFrame
): void {
  try {
    observer?.(frame);
  } catch {
    // Operational logging cannot change writer protocol or recovery state.
  }
}

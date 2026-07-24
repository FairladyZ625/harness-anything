import type {
  PendingLookup,
  PendingSubmit
} from "./repo-write-client-pending.ts";
import type {
  RepoWriteRequestFailureDiagnostic,
  RepoWriteRequestTimeoutDiagnostic
} from "./repo-write-client-contract.ts";
import {
  RepoWriteLookupError,
  RepoWriteNotStartedError,
  RepoWriteOutcomeUnknownError
} from "./repo-write-client-errors.ts";
import type {
  RepoWriteFailureFrame,
  RepoWriteTelemetryFrame
} from "./repo-write-protocol.ts";

type TimeoutObserver = (
  diagnostic: RepoWriteRequestTimeoutDiagnostic
) => void;
type FailureObserver = (
  diagnostic: RepoWriteRequestFailureDiagnostic
) => void;

export function expireRepoWriteSubmit(
  pending: PendingSubmit,
  timeoutMs: number,
  observer: TimeoutObserver | undefined
): void {
  const diagnostic =
    `Repo writer request exceeded its ${timeoutMs}ms deadline.`
    + repoWriteTelemetryTimeoutSuffix(pending.lastTelemetry);
  observeRepoWriteRequestTimeout(observer, {
    requestId: pending.requestId,
    commandName: pending.command.commandName,
    lane: "durable",
    deadlineMs: timeoutMs,
    ...(pending.opId ? { opId: pending.opId } : {}),
    ...(pending.lastTelemetry ? { lastTelemetry: pending.lastTelemetry } : {})
  });
  pending.reject(pending.phase === "proceeded" && pending.opId
    ? new RepoWriteOutcomeUnknownError(
        "REPO_WRITE_REQUEST_TIMEOUT",
        diagnostic,
        pending.opId
      )
    : new RepoWriteNotStartedError(
        "REPO_WRITE_REQUEST_TIMEOUT",
        diagnostic,
        pending.opId
      ));
}

export function expireRepoWriteLookup(
  pending: PendingLookup,
  timeoutMs: number,
  observer: TimeoutObserver | undefined
): void {
  observeRepoWriteRequestTimeout(observer, {
    requestId: pending.requestId,
    commandName: "repo-write.lookup",
    lane: "lookup",
    deadlineMs: timeoutMs,
    opId: pending.opId,
    ...(pending.lastTelemetry ? { lastTelemetry: pending.lastTelemetry } : {})
  });
  pending.reject(new RepoWriteLookupError(
    "REPO_WRITE_LOOKUP_TIMEOUT",
    `Repo writer lookup exceeded its ${timeoutMs}ms deadline.`,
    pending.opId
  ));
}

export function failRepoWriteLookup(
  pending: PendingLookup,
  message: RepoWriteFailureFrame,
  observer: FailureObserver | undefined
): void {
  observeRepoWriteRequestFailure(observer, {
    requestId: message.requestId,
    commandName: "repo-write.lookup",
    lane: "lookup",
    code: message.code,
    diagnostic: message.diagnostic,
    opId: pending.opId,
    ...(pending.lastTelemetry ? { lastTelemetry: pending.lastTelemetry } : {})
  });
  pending.reject(new RepoWriteLookupError(
    message.code,
    message.diagnostic,
    pending.opId
  ));
}

export function failRepoWriteSubmit(
  pending: PendingSubmit,
  message: RepoWriteFailureFrame,
  observer: FailureObserver | undefined
): void {
  observeRepoWriteRequestFailure(observer, {
    requestId: message.requestId,
    commandName: pending.command.commandName,
    lane: "durable",
    code: message.code,
    diagnostic: message.diagnostic,
    ...(message.opId ? { opId: message.opId } : {}),
    ...(pending.lastTelemetry ? { lastTelemetry: pending.lastTelemetry } : {})
  });
  pending.reject(message.outcome === "not-started"
    ? new RepoWriteNotStartedError(message.code, message.diagnostic, message.opId)
    : new RepoWriteOutcomeUnknownError(message.code, message.diagnostic, message.opId));
}

export function observeRepoWriteRequestTimeout(
  observer: TimeoutObserver | undefined,
  diagnostic: RepoWriteRequestTimeoutDiagnostic
): void {
  try {
    observer?.(diagnostic);
  } catch {
    // Operational logging cannot change the fail-closed timeout outcome.
  }
}

export function observeRepoWriteRequestFailure(
  observer: FailureObserver | undefined,
  diagnostic: RepoWriteRequestFailureDiagnostic
): void {
  try {
    observer?.(diagnostic);
  } catch {
    // Operational logging cannot change the fail-closed failure outcome.
  }
}

export function repoWriteTelemetryTimeoutSuffix(
  telemetry: RepoWriteTelemetryFrame | undefined
): string {
  return telemetry
    ? ` Child last reported phase=${telemetry.phase} at elapsedMs=${Math.round(telemetry.elapsedMs)}.`
    : " Child reported no execution phase.";
}

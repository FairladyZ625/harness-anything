import type {
  RepoWriteTelemetryPhase
} from "./repo-write-protocol.ts";
import type {
  RepoWriteRequestFailureDiagnostic,
  RepoWriteRequestTimeoutDiagnostic
} from "./repo-write-client-contract.ts";

export function repoWriteWaitingStage(
  phase: RepoWriteTelemetryPhase | undefined
): string {
  switch (phase) {
    case "queue":
      return "child-command-admission";
    case "compile":
      return "command-or-authority-attempt-compilation";
    case "journal":
      return "durable-operation-journal";
    case "git":
      return "canonical-git-publication";
    case "fsync":
      return "durable-attribution-evidence";
    case "materializer":
      return "authority-publication-flush";
    case "projection":
      return "daemon-write-queue:authority-publication";
    case "total":
      return "terminal-receipt-delivery";
    case undefined:
      return "child-execution-phase-unreported";
  }
}

export function formatRepoWriteFailureDiagnostic(
  diagnostic: RepoWriteRequestFailureDiagnostic
): string {
  return [
    "Repo-write child request failed",
    `command=${diagnostic.commandName}`,
    `lane=${diagnostic.lane}`,
    `waiting=${repoWriteWaitingStage(diagnostic.lastTelemetry?.phase)}`,
    `lastPhase=${diagnostic.lastTelemetry?.phase ?? "none"}`,
    `childElapsedMs=${diagnostic.lastTelemetry
      ? Math.round(diagnostic.lastTelemetry.elapsedMs)
      : "unknown"}`,
    `code=${diagnostic.code}`,
    ...(diagnostic.opId ? [`opId=${diagnostic.opId}`] : [])
  ].join(";");
}

export function formatRepoWriteTimeoutDiagnostic(
  diagnostic: RepoWriteRequestTimeoutDiagnostic
): string {
  const telemetry = diagnostic.lastTelemetry;
  return [
    `Repo-write child request timed out after ${diagnostic.deadlineMs}ms`,
    `watchdog=${diagnostic.watchdogStage}`,
    `command=${diagnostic.commandName}`,
    `lane=${diagnostic.lane}`,
    `waiting=${repoWriteWaitingStage(telemetry?.phase)}`,
    `lastPhase=${telemetry?.phase ?? "none"}`,
    `childElapsedMs=${telemetry ? Math.round(telemetry.elapsedMs) : "unknown"}`,
    ...(diagnostic.opId ? [`opId=${diagnostic.opId}`] : [])
  ].join(";");
}

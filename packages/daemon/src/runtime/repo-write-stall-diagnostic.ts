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
    case "compile-command-normalize":
      return "child-command-normalization";
    case "compile-authority-plan":
      return "authority-attempt-planning";
    case "compile-task-load":
      return "task-completion-document-loading";
    case "compile-task-holder":
      return "task-completion-holder-resolution";
    case "compile-task-witness":
      return "task-completion-prepublish-witness";
    case "compile-task-plan":
      return "task-completion-transition-planning";
    case "compile-outcome":
      return "durable-outcome-preparation";
    case "journal":
      return "durable-operation-journal";
    case "command-conflict-preflight":
    case "command-conflict-recheck":
      return phase;
    case "git":
      return "canonical-git-publication";
    case "authority-replica-change-read":
      return "authority-replica-change-read";
    case "authority-publication-proof":
      return "authority-publication-proof";
    case "authority-operation-integrity":
      return "authority-operation-integrity";
    case "authority-admission":
    case "authority-binding-verified":
    case "authority-batch-start":
    case "authority-generation-acquire":
    case "authority-generation-held":
    case "authority-coordinator-enqueue":
    case "authority-coordinator-enqueued":
    case "authority-prepared-persisted":
    case "authority-flush-start":
      return phase;
    case "authority-replication-snapshot":
      return "authority-replication-snapshot";
    case "authority-replica-change-append":
      return "authority-replica-change-append";
    case "authority-evidence-commit":
      return "authority-evidence-commit";
    case "authority-evidence-worktree":
      return "authority-evidence-worktree";
    case "authority-evidence-history-verify":
      return "authority-evidence-history-verify";
    case "authority-evidence-pending-verify":
      return "authority-evidence-pending-verify";
    case "authority-evidence-git-commit":
      return "authority-evidence-git-commit";
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

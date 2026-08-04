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
    case "authority-evidence-git-commit-done":
      return "authority-evidence-git-commit-done";
    case "authority-evidence-publish-returned":
      return "authority-evidence-publish-returned";
    case "authority-event-published":
      return "authority-event-published";
    case "authority-terminal-record-start":
      return "authority-terminal-record-start";
    case "authority-terminal-record-persisted":
      return "authority-terminal-record-persisted";
    case "authority-flush-git-commit-plan-start":
    case "authority-flush-git-commit-plan-done":
    case "authority-flush-git-session-checkout-start":
    case "authority-flush-git-session-checkout-done":
    case "authority-flush-git-stage-start":
    case "authority-flush-git-stage-done":
    case "authority-flush-git-unstage-logs-start":
    case "authority-flush-git-unstage-logs-done":
    case "authority-flush-git-trunk-checkout-start":
    case "authority-flush-git-trunk-checkout-done":
    case "authority-flush-git-commit-call-start":
    case "authority-flush-git-commit-call-done":
    case "authority-flush-git-staged-paths-start":
    case "authority-flush-git-staged-paths-done":
    case "authority-flush-git-staged-entries-start":
    case "authority-flush-git-staged-entries-done":
    case "authority-flush-git-worktree-verify-start":
    case "authority-flush-git-worktree-verify-done":
    case "authority-flush-git-alternate-index-start":
    case "authority-flush-git-alternate-index-ready":
    case "authority-flush-git-commit-start":
    case "authority-flush-git-commit-done":
    case "authority-flush-git-index-refresh-start":
    case "authority-flush-git-index-refresh-done":
    case "authority-flush-git-index-refresh-fallback-start":
    case "authority-flush-git-index-refresh-fallback-done":
    case "authority-flush-git-native-commit-start":
    case "authority-flush-git-native-commit-done":
    case "authority-flush-projection-fingerprint-start":
    case "authority-flush-projection-fingerprint-done":
    case "authority-flush-post-commit-attribution-confirm-start":
    case "authority-flush-post-commit-attribution-confirm-done":
    case "authority-flush-post-commit-projection-hash-start":
    case "authority-flush-post-commit-projection-hash-done":
    case "authority-flush-post-commit-watermark-start":
    case "authority-flush-post-commit-watermark-done":
    case "authority-flush-post-commit-compaction-start":
    case "authority-flush-post-commit-compaction-done":
    case "authority-flush-post-commit-projection-notify-start":
    case "authority-flush-post-commit-projection-notify-done":
      return phase;
    case "runtime-event-append-start":
      return "runtime-event ledger append";
    case "runtime-event-append-done":
      return "runtime-event ledger append done";
    case "authority-materializer-start":
      return "authority-materializer-start";
    case "authority-materializer-baseline-start":
      return "authority-materializer-baseline";
    case "authority-materializer-baseline-done":
      return "authority-materializer-baseline-done";
    case "authority-materializer-merge-start":
      return "authority-materializer-merge";
    case "authority-materializer-merge-done":
      return "authority-materializer-merge-done";
    case "authority-materializer-projection-start":
      return "authority-materializer-projection";
    case "authority-materializer-projection-load-current":
    case "authority-materializer-projection-capture-source":
    case "authority-materializer-projection-derive-affected":
    case "authority-materializer-projection-declared-delta":
    case "authority-materializer-projection-hash-next":
    case "authority-materializer-projection-verify-source":
    case "authority-materializer-projection-source-cache-refresh":
    case "authority-materializer-projection-source-cache-change":
    case "authority-materializer-projection-attribution-delta":
    case "authority-materializer-projection-source-delta":
    case "authority-materializer-projection-publish":
    case "authority-materializer-projection-database-start":
    case "authority-materializer-projection-database-task-rows-done":
    case "authority-materializer-projection-database-decision-rows-done":
    case "authority-materializer-projection-database-graph-rows-done":
    case "authority-materializer-projection-database-declared-rows-done":
    case "authority-materializer-projection-database-source-cache-done":
    case "authority-materializer-projection-database-attribution-done":
    case "authority-materializer-projection-database-meta-done":
    case "authority-materializer-projection-database-commit-start":
    case "authority-materializer-projection-database-commit-done":
    case "authority-materializer-projection-database-done":
    case "authority-materializer-projection-mode-incremental":
    case "authority-materializer-projection-mode-rebuild":
    case "authority-materializer-projection-mode-unchanged":
      return phase;
    case "authority-materializer-projection-done":
      return "authority-materializer-projection-done";
    case "authority-materializer-attribution-start":
      return "authority-materializer-attribution";
    case "authority-materializer-attribution-done":
      return "authority-materializer-attribution-done";
    case "authority-materializer-end":
      return "authority-materializer-end";
    case "child-execution-returned":
      return "child-execution-returned";
    case "child-telemetry-flushed":
      return "child-telemetry-flushed";
    case "child-terminal-response":
      return "child-terminal-response";
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

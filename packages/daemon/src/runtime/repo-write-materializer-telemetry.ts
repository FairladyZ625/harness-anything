import {
  runLedgerMaterializer,
  type IncrementalProjectionPhase,
  type IncrementalProjectionDiagnostic,
  type IncrementalProjectionRebuildReason,
  type IncrementalTaskProjectionMode,
  type AttributionProjectionDecisionReason,
  type JournalPostCommitPhase,
  type JournalProjectionFingerprintPhase,
  type LedgerMaterializerProgressStep,
  type VcsCommitPhase
} from "@harness-anything/kernel";
import type {
  ProjectionSourceSummary,
  ProjectionSourceWorktreeFenceDiagnostic,
  TrustedProjectionFingerprintDiagnostic
} from "@harness-anything/kernel";
import { reportCurrentRepoWriteTelemetry } from "./repo-write-telemetry-context.ts";
import type { RepoWriteTelemetryDetails, RepoWriteTelemetryPhase } from "./repo-write-protocol.ts";

const materializerProgressPhases: Record<LedgerMaterializerProgressStep, RepoWriteTelemetryPhase> = {
  "baseline-start": "authority-materializer-baseline-start",
  "baseline-done": "authority-materializer-baseline-done",
  "merge-start": "authority-materializer-merge-start",
  "merge-done": "authority-materializer-merge-done",
  "projection-start": "authority-materializer-projection-start",
  "projection-done": "authority-materializer-projection-done",
  "attribution-start": "authority-materializer-attribution-start",
  "attribution-done": "authority-materializer-attribution-done"
};

const projectionPhases: Record<IncrementalProjectionPhase["phase"], RepoWriteTelemetryPhase> = {
  "load-current": "authority-materializer-projection-load-current",
  "capture-source": "authority-materializer-projection-capture-source",
  "derive-affected": "authority-materializer-projection-derive-affected",
  "declared-delta": "authority-materializer-projection-declared-delta",
  "hash-next": "authority-materializer-projection-hash-next",
  "verify-source": "authority-materializer-projection-verify-source",
  "source-cache-refresh": "authority-materializer-projection-source-cache-refresh",
  "source-cache-change": "authority-materializer-projection-source-cache-change",
  "attribution-delta": "authority-materializer-projection-attribution-delta",
  "source-delta": "authority-materializer-projection-source-delta",
  publish: "authority-materializer-projection-publish",
  "database-start": "authority-materializer-projection-database-start",
  "database-task-rows-done": "authority-materializer-projection-database-task-rows-done",
  "database-decision-rows-done": "authority-materializer-projection-database-decision-rows-done",
  "database-graph-rows-done": "authority-materializer-projection-database-graph-rows-done",
  "database-declared-rows-done": "authority-materializer-projection-database-declared-rows-done",
  "database-source-cache-done": "authority-materializer-projection-database-source-cache-done",
  "database-attribution-done": "authority-materializer-projection-database-attribution-done",
  "database-meta-done": "authority-materializer-projection-database-meta-done",
  "database-commit-start": "authority-materializer-projection-database-commit-start",
  "database-commit-done": "authority-materializer-projection-database-commit-done",
  "database-done": "authority-materializer-projection-database-done"
};

const projectionModes: Record<IncrementalTaskProjectionMode, RepoWriteTelemetryPhase> = {
  incremental: "authority-materializer-projection-mode-incremental",
  rebuild: "authority-materializer-projection-mode-rebuild",
  unchanged: "authority-materializer-projection-mode-unchanged"
};

const projectionRebuildReasons: Record<IncrementalProjectionRebuildReason, RepoWriteTelemetryPhase> = {
  "projection-missing": "authority-materializer-projection-mode-rebuild-reason-projection-missing",
  "projection-read-failed": "authority-materializer-projection-mode-rebuild-reason-projection-read-failed",
  "projection-version-mismatch": "authority-materializer-projection-mode-rebuild-reason-projection-version-mismatch",
  "source-cache-invalid": "authority-materializer-projection-mode-rebuild-reason-source-cache-invalid",
  "projection-metadata-read-failed": "authority-materializer-projection-mode-rebuild-reason-projection-metadata-read-failed",
  "projection-integrity-mismatch": "authority-materializer-projection-mode-rebuild-reason-projection-integrity-mismatch",
  "relation-graph-reuse-unavailable": "authority-materializer-projection-mode-rebuild-reason-relation-graph-reuse-unavailable",
  "declared-projection-delta-failed": "authority-materializer-projection-mode-rebuild-reason-declared-projection-delta-failed",
  "source-fingerprint-mismatch": "authority-materializer-projection-mode-rebuild-reason-source-fingerprint-mismatch",
  "source-verification-race": "authority-materializer-projection-mode-rebuild-reason-source-verification-race",
  "source-verification-failed": "authority-materializer-projection-mode-rebuild-reason-source-verification-failed",
  "source-cache-reload-failed": "authority-materializer-projection-mode-rebuild-reason-source-cache-reload-failed",
  "source-cache-refresh-failed": "authority-materializer-projection-mode-rebuild-reason-source-cache-refresh-failed",
  "attribution-cache-change-missing": "authority-materializer-projection-mode-rebuild-reason-attribution-cache-change-missing",
  "projection-update-recovered": "authority-materializer-projection-mode-rebuild-reason-projection-update-recovered"
};

const attributionDecisionReasons: Record<AttributionProjectionDecisionReason, RepoWriteTelemetryPhase> = {
  "delete-present": "authority-materializer-projection-attribution-decision-delete-present",
  "non-single-upsert": "authority-materializer-projection-attribution-decision-non-single-upsert",
  "source-path-exists": "authority-materializer-projection-attribution-decision-source-path-exists",
  "event-decode-failed": "authority-materializer-projection-attribution-decision-event-decode-failed",
  "projected-read-failed": "authority-materializer-projection-attribution-decision-projected-read-failed",
  "op-id-ambiguous": "authority-materializer-projection-attribution-decision-op-id-ambiguous",
  "v1-v2-precedence": "authority-materializer-projection-attribution-decision-v1-v2-precedence",
  replay: "authority-materializer-projection-attribution-decision-replay",
  "new-source-path": "authority-materializer-projection-attribution-decision-new-source-path",
  "v1-to-v2-replacement": "authority-materializer-projection-attribution-decision-v1-to-v2-replacement",
  "op-id-collision": "authority-materializer-projection-attribution-decision-op-id-collision",
  other: "authority-materializer-projection-attribution-decision-other"
};

const commitPhases: Record<VcsCommitPhase, RepoWriteTelemetryPhase> = {
  "commit-plan-start": "authority-flush-git-commit-plan-start",
  "commit-plan-done": "authority-flush-git-commit-plan-done",
  "session-checkout-start": "authority-flush-git-session-checkout-start",
  "session-checkout-done": "authority-flush-git-session-checkout-done",
  "stage-start": "authority-flush-git-stage-start",
  "stage-done": "authority-flush-git-stage-done",
  "unstage-logs-start": "authority-flush-git-unstage-logs-start",
  "unstage-logs-done": "authority-flush-git-unstage-logs-done",
  "trunk-checkout-start": "authority-flush-git-trunk-checkout-start",
  "trunk-checkout-done": "authority-flush-git-trunk-checkout-done",
  "commit-call-start": "authority-flush-git-commit-call-start",
  "commit-call-done": "authority-flush-git-commit-call-done",
  "staged-paths-start": "authority-flush-git-staged-paths-start",
  "staged-paths-done": "authority-flush-git-staged-paths-done",
  "staged-entries-start": "authority-flush-git-staged-entries-start",
  "staged-entries-done": "authority-flush-git-staged-entries-done",
  "worktree-verify-start": "authority-flush-git-worktree-verify-start",
  "worktree-verify-done": "authority-flush-git-worktree-verify-done",
  "alternate-index-start": "authority-flush-git-alternate-index-start",
  "alternate-index-ready": "authority-flush-git-alternate-index-ready",
  "commit-start": "authority-flush-git-commit-start",
  "commit-done": "authority-flush-git-commit-done",
  "index-refresh-start": "authority-flush-git-index-refresh-start",
  "index-refresh-done": "authority-flush-git-index-refresh-done",
  "index-refresh-fallback-start": "authority-flush-git-index-refresh-fallback-start",
  "index-refresh-fallback-done": "authority-flush-git-index-refresh-fallback-done",
  "native-commit-start": "authority-flush-git-native-commit-start",
  "native-commit-done": "authority-flush-git-native-commit-done"
};

export function materializerProgressPhase(step: LedgerMaterializerProgressStep): RepoWriteTelemetryPhase {
  return materializerProgressPhases[step];
}

export function materializerProjectionPhase(phase: IncrementalProjectionPhase): RepoWriteTelemetryPhase {
  return projectionPhases[phase.phase];
}

export function materializerProjectionModePhase(mode: IncrementalTaskProjectionMode): RepoWriteTelemetryPhase {
  return projectionModes[mode];
}

export function materializerProjectionRebuildReasonPhase(reason: IncrementalProjectionRebuildReason): RepoWriteTelemetryPhase {
  return projectionRebuildReasons[reason];
}

export function materializerAttributionDecisionPhase(reason: AttributionProjectionDecisionReason): RepoWriteTelemetryPhase {
  return attributionDecisionReasons[reason];
}

export function flushGitCommitPhase(phase: VcsCommitPhase): RepoWriteTelemetryPhase {
  return commitPhases[phase];
}

export function reportFlushGitCommitPhase(phase: VcsCommitPhase): void {
  reportCurrentRepoWriteTelemetry(flushGitCommitPhase(phase));
}

const postCommitPhases: Record<JournalPostCommitPhase, RepoWriteTelemetryPhase> = {
  "attribution-confirm-start": "authority-flush-post-commit-attribution-confirm-start",
  "attribution-confirm-done": "authority-flush-post-commit-attribution-confirm-done",
  "projection-hash-start": "authority-flush-post-commit-projection-hash-start",
  "projection-hash-done": "authority-flush-post-commit-projection-hash-done",
  "watermark-start": "authority-flush-post-commit-watermark-start",
  "watermark-done": "authority-flush-post-commit-watermark-done",
  "compaction-start": "authority-flush-post-commit-compaction-start",
  "compaction-done": "authority-flush-post-commit-compaction-done",
  "projection-notify-start": "authority-flush-post-commit-projection-notify-start",
  "projection-notify-done": "authority-flush-post-commit-projection-notify-done"
};

export function reportFlushPostCommitPhase(phase: JournalPostCommitPhase): void {
  reportCurrentRepoWriteTelemetry(postCommitPhases[phase]);
}

const projectionFingerprintPhases: Record<JournalProjectionFingerprintPhase, RepoWriteTelemetryPhase> = {
  "capture-start": "authority-flush-projection-fingerprint-start",
  "capture-done": "authority-flush-projection-fingerprint-done"
};

export function reportFlushProjectionFingerprintPhase(phase: JournalProjectionFingerprintPhase): void {
  reportCurrentRepoWriteTelemetry(projectionFingerprintPhases[phase]);
}

export function reportFlushProjectionFingerprintDiagnostic(
  diagnostic: TrustedProjectionFingerprintDiagnostic
): void {
  reportProjectionDiagnostic(diagnostic, "flush");
}

type ProjectionDiagnostic = TrustedProjectionFingerprintDiagnostic | IncrementalProjectionDiagnostic;

function reportProjectionDiagnostic(
  diagnostic: ProjectionDiagnostic,
  location: "flush" | "materializer"
): void {
  if (diagnostic.kind === "cache") {
    if (diagnostic.fence) {
      reportCurrentRepoWriteTelemetry(
        location === "flush"
          ? "authority-flush-projection-fingerprint-summary"
          : "authority-materializer-baseline-fence",
        fenceDetails(diagnostic.fence)
      );
    }
    reportCurrentRepoWriteTelemetry(
      location === "flush"
        ? "authority-flush-projection-fingerprint-summary"
        : "authority-materializer-baseline-cache",
      {
        kind: "cache",
        outcome: diagnostic.outcome,
        reason: diagnostic.reason,
        head: diagnostic.head,
        ...(diagnostic.cachedHead ? { cachedHead: diagnostic.cachedHead } : {}),
        ...(diagnostic.cachedFingerprint ? { cachedFingerprint: diagnostic.cachedFingerprint } : {}),
        ...(diagnostic.worktreeVerified !== undefined ? { worktreeVerified: diagnostic.worktreeVerified } : {})
      }
    );
    if (diagnostic.summary) {
      reportCurrentRepoWriteTelemetry(
        location === "flush"
          ? "authority-flush-projection-fingerprint-summary"
          : "authority-materializer-projection-source-summary",
        sourceSummaryDetails(diagnostic.summary)
      );
    }
    return;
  }

  if (diagnostic.kind !== "advance") return;

  reportCurrentRepoWriteTelemetry(
    location === "flush"
      ? "authority-flush-projection-fingerprint-summary"
      : "authority-materializer-baseline-fence",
    fenceDetails(diagnostic.fence)
  );
  reportCurrentRepoWriteTelemetry(
    location === "flush"
      ? "authority-flush-projection-fingerprint-summary"
      : "authority-materializer-projection-trusted-advance",
    {
      kind: "advance",
      outcome: diagnostic.outcome,
      reason: diagnostic.reason,
      head: diagnostic.head,
      cachedHead: diagnostic.cachedHead,
      cachedFingerprint: diagnostic.cachedFingerprint,
      ...(diagnostic.fingerprint ? { fingerprint: diagnostic.fingerprint } : {})
    }
  );
}

export function reportMaterializerProjectionDiagnostic(
  diagnostic: IncrementalProjectionDiagnostic
): void {
  reportCurrentRepoWriteTelemetry(
    "authority-materializer-projection-source-summary",
    sourceSummaryDetails(diagnostic.summary)
  );
  reportCurrentRepoWriteTelemetry(
    "authority-materializer-projection-metadata-summary",
    {
      kind: "metadata",
      phase: diagnostic.phase,
      existingSourceHash: diagnostic.existingSourceHash,
      ...(diagnostic.previousSourceFingerprint
        ? { previousSourceFingerprint: diagnostic.previousSourceFingerprint }
        : {}),
      ...(diagnostic.storedSourceHash ? { storedSourceHash: diagnostic.storedSourceHash } : {})
    }
  );
}

function fenceDetails(fence: ProjectionSourceWorktreeFenceDiagnostic): RepoWriteTelemetryDetails {
  return {
    kind: "fence",
    clean: fence.clean,
    statusCount: fence.statusCount,
    sourceDirtyCount: fence.sourceDirtyCount,
    unparseableStatusCount: fence.unparseableStatusCount,
    sourceDirtyCategoryHash: fence.sourceDirtyCategoryHash
  };
}

function sourceSummaryDetails(summary: ProjectionSourceSummary): RepoWriteTelemetryDetails {
  return {
    kind: "source-summary",
    taskEntryCount: summary.taskEntryCount,
    taskInputCount: summary.taskInputCount,
    taskSourceHash: summary.taskSourceHash,
    declaredSourceCount: summary.declaredSourceCount,
    declaredInputCount: summary.declaredInputCount,
    declaredSourceHash: summary.declaredSourceHash,
    attributionInputCount: summary.attributionInputCount,
    attributionSourceHash: summary.attributionSourceHash,
    legacyPersonIdCount: summary.legacyPersonIdCount,
    legacyPersonIdsHash: summary.legacyPersonIdsHash,
    fingerprint: summary.fingerprint
  };
}

export function runMaterializerWithRepoWriteTelemetry(
  rootInput: Parameters<typeof runLedgerMaterializer>[0],
  options: NonNullable<Parameters<typeof runLedgerMaterializer>[1]> = {}
): ReturnType<typeof runLedgerMaterializer> {
  reportCurrentRepoWriteTelemetry("authority-materializer-start");
  try {
    return runLedgerMaterializer(rootInput, {
      ...options,
      onProgress: (step) => {
        reportCurrentRepoWriteTelemetry(materializerProgressPhase(step));
        options.onProgress?.(step);
      },
      onProjectionPhase: (phase) => {
        reportCurrentRepoWriteTelemetry(materializerProjectionPhase(phase));
        options.onProjectionPhase?.(phase);
      },
      onProjectionMode: (mode, reason) => {
        reportCurrentRepoWriteTelemetry(materializerProjectionModePhase(mode));
        if (reason) reportCurrentRepoWriteTelemetry(materializerProjectionRebuildReasonPhase(reason));
        options.onProjectionMode?.(mode, reason);
      },
      onProjectionDiagnostic: (diagnostic) => {
        if (diagnostic.kind === "cache" || diagnostic.kind === "advance") {
          reportProjectionDiagnostic(diagnostic, "materializer");
        } else {
          reportMaterializerProjectionDiagnostic(diagnostic);
        }
        options.onProjectionDiagnostic?.(diagnostic);
      },
      onProjectionAttributionDecision: (reason) => {
        reportCurrentRepoWriteTelemetry(materializerAttributionDecisionPhase(reason));
        options.onProjectionAttributionDecision?.(reason);
      }
    });
  } finally {
    reportCurrentRepoWriteTelemetry("authority-materializer-end");
  }
}

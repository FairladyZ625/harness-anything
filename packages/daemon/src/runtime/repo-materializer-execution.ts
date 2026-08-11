import type { HarnessLayoutInput, LedgerMaterializerReport } from "@harness-anything/kernel";
import type { DaemonGlobalLock } from "@harness-anything/kernel/daemon-runtime-support";
import type { DaemonMaterializerBatchOptions } from "./repo-runtime-options.ts";
import { bindCurrentRepoWriteTelemetry, reportCurrentRepoWriteTelemetry } from "./repo-write-telemetry-context.ts";
import {
  materializerAttributionDecisionPhase,
  materializerProgressPhase,
  materializerProjectionModePhase,
  materializerProjectionPhase,
  materializerProjectionRebuildReasonPhase,
  reportMaterializerProjectionDiagnostic
} from "./repo-write-materializer-telemetry.ts";
import type { RepoMaterializerWorker } from "./repo-materializer-worker.ts";

export async function runRepoMaterializerBatch(input: {
  readonly rootInput: HarnessLayoutInput;
  readonly lock: DaemonGlobalLock;
  readonly options: DaemonMaterializerBatchOptions;
  readonly maxBranches: number;
  readonly worker: RepoMaterializerWorker;
  readonly knownPendingSessions: Set<string>;
  readonly invalidateProjection: () => void;
  readonly rememberFingerprint: (sourceHash: string) => void;
  readonly setLastError: (value: string | undefined) => void;
}): Promise<LedgerMaterializerReport> {
  reportCurrentRepoWriteTelemetry("authority-materializer-start");
  const onProgress = bindCurrentRepoWriteTelemetry((step: Parameters<typeof materializerProgressPhase>[0]) => {
    reportCurrentRepoWriteTelemetry(materializerProgressPhase(step));
  });
  const onProjectionPhase = bindCurrentRepoWriteTelemetry((phase: Parameters<typeof materializerProjectionPhase>[0]) => {
    reportCurrentRepoWriteTelemetry(materializerProjectionPhase(phase));
  });
  const onProjectionMode = bindCurrentRepoWriteTelemetry((
    mode: Parameters<typeof materializerProjectionModePhase>[0],
    reason?: Parameters<typeof materializerProjectionRebuildReasonPhase>[0]
  ) => {
    reportCurrentRepoWriteTelemetry(materializerProjectionModePhase(mode));
    if (reason) reportCurrentRepoWriteTelemetry(materializerProjectionRebuildReasonPhase(reason));
  });
  const onProjectionAttributionDecision = bindCurrentRepoWriteTelemetry((
    reason: Parameters<typeof materializerAttributionDecisionPhase>[0]
  ) => reportCurrentRepoWriteTelemetry(materializerAttributionDecisionPhase(reason)));
  const onProjectionDiagnostic = bindCurrentRepoWriteTelemetry(reportMaterializerProjectionDiagnostic);
  let report: LedgerMaterializerReport;
  try {
    report = await input.worker.run(input.rootInput, {
      heldGlobalLock: input.lock,
      ...(input.options.dryRun ? { dryRun: true } : {}),
      ...(input.options.sessionId
        ? { sessionId: input.options.sessionId }
        : { maxBranches: input.maxBranches })
    }, {
      onProgress,
      onProjectionPhase,
      onProjectionMode,
      onProjectionAttributionDecision,
      onProjectionDiagnostic
    }, input.options.priority ?? "foreground");
  } finally {
    reportCurrentRepoWriteTelemetry("authority-materializer-end");
  }
  recordMaterializerOutcome(input, report);
  return report;
}

function recordMaterializerOutcome(
  input: Parameters<typeof runRepoMaterializerBatch>[0],
  report: LedgerMaterializerReport
): void {
  if (report.projectionRebuilt) input.invalidateProjection();
  if (report.projectionSourceHash) input.rememberFingerprint(report.projectionSourceHash);
  if (report.warnings.length > 0) input.setLastError(report.warnings.join("; "));
  else if (!input.options.sessionId) input.setLastError(undefined);

  if (input.options.sessionId) {
    const target = report.branches.find((branch) => branch.branch === `sessions/${input.options.sessionId}`);
    if (report.warnings.length === 0 && (!target || target.status === "merged" || target.status === "skipped")) {
      input.knownPendingSessions.delete(input.options.sessionId);
    }
    return;
  }
  for (const branch of report.branches) {
    if ((branch.status === "merged" || branch.status === "skipped") && branch.branch.startsWith("sessions/")) {
      input.knownPendingSessions.delete(branch.branch.slice("sessions/".length));
    }
  }
}

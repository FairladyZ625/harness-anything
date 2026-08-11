import { isIndeterminateFlushReport, type FlushReport, type LedgerMaterializerReport } from "@harness-anything/kernel";
import type { DaemonWriteQueue } from "./write-queue.ts";
import { measureCurrentDaemonRequestPerformancePhase } from "../observability/request-performance.ts";
import {
  bindCurrentRepoWriteTelemetry,
  reportCurrentRepoWriteTelemetry
} from "./repo-write-telemetry-context.ts";
import {
  captureCurrentAuthorityDurableAcceptanceReporter,
  waitForCurrentAuthoritySettlementRelease
} from "./authority-durable-acceptance-context.ts";

export interface DaemonAuthorityPublicationOptions {
  readonly sessionId: string;
  readonly publish: () => Promise<FlushReport>;
}

export interface DaemonAuthorityPublicationReport {
  readonly flush: FlushReport;
  readonly acceptedCommitSha?: string;
  readonly canonicalCommitSha?: string;
  readonly materialization?: LedgerMaterializerReport;
}

export function enqueueDaemonAuthorityPublication(
  queue: DaemonWriteQueue,
  options: DaemonAuthorityPublicationOptions,
  materialize: (sessionId: string) => LedgerMaterializerReport | Promise<LedgerMaterializerReport>,
  resolveAcceptedCommitSha: (sessionId: string) => string,
  resolveCanonicalCommitContaining: (acceptedCommitSha: string) => string | undefined = () => undefined,
  scheduleMaterializer: <Result>(run: () => Result | Promise<Result>) => Promise<Result> = (run) =>
    queue.enqueueBackground({ source: "authority-publication", priority: "background", run })
): Promise<DaemonAuthorityPublicationReport> {
  reportCurrentRepoWriteTelemetry("projection");
  const reportDurableAcceptance = captureCurrentAuthorityDurableAcceptanceReporter();
  const durableAcceptance = queue.enqueueBackground({
    source: "authority-publication",
    priority: "normal",
    run: bindCurrentRepoWriteTelemetry(async () => {
      const flush = await measureCurrentDaemonRequestPerformancePhase(
        "durable-flush",
        options.publish
      );
      if (!isIndeterminateFlushReport(flush) && flush.committed && flush.opCount > 0 && flush.watermark) {
        const acceptedCommitSha = resolveAcceptedCommitSha(options.sessionId);
        reportDurableAcceptance?.({
          sessionId: options.sessionId,
          acceptedCommitSha,
          flush: { ...flush, committed: true, watermark: flush.watermark }
        });
        return { flush, acceptedCommitSha };
      }
      return { flush };
    })
  });
  return durableAcceptance.then(async ({ flush, acceptedCommitSha }) => {
    if (isIndeterminateFlushReport(flush) || !flush.committed || flush.opCount === 0) return { flush };
    await waitForCurrentAuthoritySettlementRelease();
    return scheduleMaterializer(bindCurrentRepoWriteTelemetry(async () => {
        reportCurrentRepoWriteTelemetry("materializer");
        reportCurrentRepoWriteTelemetry("git");
        reportCurrentRepoWriteTelemetry("fsync");
        const materialization = await measureCurrentDaemonRequestPerformancePhase(
          "materializer",
          () => materialize(options.sessionId)
        );
        reportCurrentRepoWriteTelemetry("total");
        const canonicalCommitSha = acceptedCommitSha
          ? resolveCanonicalCommitContaining(acceptedCommitSha)
          : undefined;
        return {
          flush,
          ...(acceptedCommitSha ? { acceptedCommitSha } : {}),
          ...(canonicalCommitSha ? { canonicalCommitSha } : {}),
          materialization
        };
      }));
  });
}

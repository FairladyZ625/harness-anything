import { isIndeterminateFlushReport, type FlushReport, type LedgerMaterializerReport } from "@harness-anything/kernel";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
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
  materialize: (sessionId: string) => LedgerMaterializerReport,
  resolveAcceptedCommitSha: (sessionId: string) => string,
  resolveCanonicalCommitContaining: (acceptedCommitSha: string) => string | undefined = () => undefined
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
    // The production queue may begin a synchronous materializer inside
    // enqueueBackground. Yield once so admission continuations can persist and
    // deliver the durable receipt before that CPU/Git work starts.
    await nextEventLoopTurn();
    return queue.enqueueBackground({
      source: "authority-publication",
      priority: "background",
      run: bindCurrentRepoWriteTelemetry(() => {
        reportCurrentRepoWriteTelemetry("materializer");
        reportCurrentRepoWriteTelemetry("git");
        reportCurrentRepoWriteTelemetry("fsync");
        const materialization = measureCurrentDaemonRequestPerformancePhase(
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
      })
    });
  });
}

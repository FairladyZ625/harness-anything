import type { FlushReport, LedgerMaterializerReport } from "@harness-anything/kernel";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import type { DaemonWriteQueue } from "./write-queue.ts";
import { measureCurrentDaemonRequestPerformancePhase } from "../observability/request-performance.ts";
import {
  bindCurrentRepoWriteTelemetry,
  reportCurrentRepoWriteTelemetry
} from "./repo-write-telemetry-context.ts";
import {
  reportCurrentAuthorityDurableAcceptance,
  waitForCurrentAuthoritySettlementRelease
} from "./authority-durable-acceptance-context.ts";

export interface DaemonAuthorityPublicationOptions {
  readonly sessionId: string;
  readonly publish: () => Promise<FlushReport>;
}

export interface DaemonAuthorityPublicationReport {
  readonly flush: FlushReport;
  readonly materialization?: LedgerMaterializerReport;
}

export function enqueueDaemonAuthorityPublication(
  queue: DaemonWriteQueue,
  options: DaemonAuthorityPublicationOptions,
  materialize: (sessionId: string) => LedgerMaterializerReport,
  resolveAcceptedCommitSha: (sessionId: string) => string
): Promise<DaemonAuthorityPublicationReport> {
  reportCurrentRepoWriteTelemetry("projection");
  const durableAcceptance = queue.enqueueBackground({
    source: "authority-publication",
    priority: "normal",
    run: bindCurrentRepoWriteTelemetry(async () => {
      const flush = await measureCurrentDaemonRequestPerformancePhase(
        "durable-flush",
        options.publish
      );
      if (flush.committed && flush.opCount > 0) {
        reportCurrentAuthorityDurableAcceptance(
          options.sessionId,
          resolveAcceptedCommitSha(options.sessionId),
          flush
        );
      }
      return flush;
    })
  });
  return durableAcceptance.then(async (flush) => {
    if (!flush.committed || flush.opCount === 0) return { flush };
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
        return { flush, materialization };
      })
    });
  });
}

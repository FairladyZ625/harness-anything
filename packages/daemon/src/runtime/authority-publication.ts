import type { FlushReport, LedgerMaterializerReport } from "@harness-anything/kernel";
import type { DaemonWriteQueue } from "./write-queue.ts";
import { measureCurrentDaemonRequestPerformancePhase } from "../observability/request-performance.ts";
import {
  bindCurrentRepoWriteTelemetry,
  reportCurrentRepoWriteTelemetry
} from "./repo-write-telemetry-context.ts";

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
  materialize: (sessionId: string) => LedgerMaterializerReport
): Promise<DaemonAuthorityPublicationReport> {
  reportCurrentRepoWriteTelemetry("projection");
  return queue.enqueueBackground({
    source: "authority-publication",
    priority: "normal",
    run: bindCurrentRepoWriteTelemetry(async () => {
      reportCurrentRepoWriteTelemetry("materializer");
      const flush = await measureCurrentDaemonRequestPerformancePhase(
        "durable-flush",
        options.publish
      );
      reportCurrentRepoWriteTelemetry("git");
      if (!flush.committed || flush.opCount === 0) return { flush };
      reportCurrentRepoWriteTelemetry("fsync");
      const result = {
        flush,
        materialization: measureCurrentDaemonRequestPerformancePhase(
          "materializer",
          () => materialize(options.sessionId)
        )
      };
      reportCurrentRepoWriteTelemetry("total");
      return result;
    })
  });
}

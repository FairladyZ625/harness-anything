import type { FlushReport, LedgerMaterializerReport } from "@harness-anything/kernel";
import type { DaemonWriteQueue } from "./write-queue.ts";
import { measureCurrentDaemonRequestPerformancePhase } from "../observability/request-performance.ts";

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
  return queue.enqueueBackground({
    source: "authority-publication",
    priority: "normal",
    run: async () => {
      const flush = await measureCurrentDaemonRequestPerformancePhase(
        "durable-flush",
        options.publish
      );
      if (!flush.committed || flush.opCount === 0) return { flush };
      return {
        flush,
        materialization: measureCurrentDaemonRequestPerformancePhase(
          "materializer",
          () => materialize(options.sessionId)
        )
      };
    }
  });
}

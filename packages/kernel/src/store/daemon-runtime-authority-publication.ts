import type { FlushReport } from "../ports/write-coordinator.ts";
import type { DaemonWriteQueue } from "./daemon-runtime-queue.ts";
import type { LedgerMaterializerReport } from "./ledger-materializer.ts";

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
      const flush = await options.publish();
      if (!flush.committed || flush.opCount === 0) return { flush };
      return { flush, materialization: materialize(options.sessionId) };
    }
  });
}

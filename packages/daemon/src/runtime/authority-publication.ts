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
  options: DaemonAuthorityPublicationOptions
): Promise<DaemonAuthorityPublicationReport> {
  reportCurrentRepoWriteTelemetry("projection");
  return queue.enqueueBackground({
    source: "authority-publication",
    priority: "normal",
    run: bindCurrentRepoWriteTelemetry(async () => {
      const flush = await measureCurrentDaemonRequestPerformancePhase(
        "durable-flush",
        options.publish
      );
      reportCurrentRepoWriteTelemetry("git");
      reportCurrentRepoWriteTelemetry("total");
      return { flush };
    })
  });
}

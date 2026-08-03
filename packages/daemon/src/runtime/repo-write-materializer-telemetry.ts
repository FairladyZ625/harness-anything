import {
  runLedgerMaterializer,
  type LedgerMaterializerProgressStep
} from "@harness-anything/kernel";
import { reportCurrentRepoWriteTelemetry } from "./repo-write-telemetry-context.ts";
import type { RepoWriteTelemetryPhase } from "./repo-write-protocol.ts";

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

export function materializerProgressPhase(step: LedgerMaterializerProgressStep): RepoWriteTelemetryPhase {
  return materializerProgressPhases[step];
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
      }
    });
  } finally {
    reportCurrentRepoWriteTelemetry("authority-materializer-end");
  }
}

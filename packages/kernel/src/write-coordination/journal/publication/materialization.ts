import { Effect } from "effect";
import type { WriteError } from "../../../domain/index.ts";
import type { VersionControlSystem } from "../../../ports/version-control-system.ts";
import type { FlushReport } from "../../../ports/write-coordinator.ts";
import type { HarnessLayoutInput } from "../../../layout/index.ts";
import { runLedgerMaterializer } from "../../materialization/ledger-materializer.ts";

export function maybeAutoMaterialize(
  effect: Effect.Effect<FlushReport, WriteError>,
  rootInput: HarnessLayoutInput,
  sessionId: string | undefined,
  autoMaterialize: boolean,
  versionControlSystem?: VersionControlSystem
): Effect.Effect<FlushReport, WriteError> {
  if (!sessionId || !autoMaterialize) return effect;
  return effect.pipe(
    Effect.tap((report) => {
      if (report.opCount === 0 || !report.committed) return Effect.void;
      return Effect.sync(() => {
        try {
          runLedgerMaterializer(rootInput, { versionControlSystem });
        } catch {
          // The op is already committed and covered by the durable watermark.
          // Materialization is a separately retryable convergence step.
        }
      });
    })
  );
}

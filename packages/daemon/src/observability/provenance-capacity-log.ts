import type { DaemonLogRepoContext, DaemonLogService } from "@harness-anything/application";
import {
  completeProvenanceCapacityObservation,
  readProvenanceLedgerScale,
  type ProvenanceCapacitySignal
} from "./provenance-capacity-trigger.ts";

export function scheduleProvenanceCapacityLog(
  daemonLogService: DaemonLogService,
  context: DaemonLogRepoContext,
  authoredGitRoot: string,
  signal: ProvenanceCapacitySignal
): void {
  setImmediate(() => {
    void readProvenanceLedgerScale(authoredGitRoot)
      .then((scale) => {
        const observation = completeProvenanceCapacityObservation(signal, scale);
        return daemonLogService.append({
          level: signal.status === "ok" ? "info" : "warn",
          source: "daemon",
          component: "repo-write-child",
          event: provenanceCapacityEvent(signal.status),
          message: JSON.stringify(observation),
          ...(signal.status === "alert" ? {
            errorCode: "PROVENANCE_CAPACITY_HEADROOM_LOW",
            hint: "Start the indexed provenance implementation task; do not raise the writer deadline."
          } : signal.status === "measurement-failed" ? {
            errorCode: "PROVENANCE_CAPACITY_TELEMETRY_INCOMPLETE",
            hint: "Inspect the request telemetry before treating capacity as healthy."
          } : {}),
          requestId: signal.requestId
        }, context);
      })
      .catch(() => {
        const fallbackStatus = signal.status === "alert" ? "alert" : "measurement-failed";
        return daemonLogService.append({
          level: "warn",
          source: "daemon",
          component: "repo-write-child",
          event: provenanceCapacityEvent(fallbackStatus),
          message: JSON.stringify({
            ...signal,
            schema: "provenance-capacity-observation-partial/v1",
            status: fallbackStatus,
            ledgerScale: null
          }),
          errorCode: fallbackStatus === "alert"
            ? "PROVENANCE_CAPACITY_HEADROOM_LOW"
            : "PROVENANCE_CAPACITY_SCALE_UNAVAILABLE",
          hint: "The writer timing remains valid, but ledger commit counts could not be read; inspect the authored Git repository.",
          requestId: signal.requestId
        }, context);
      })
      .catch(() => undefined);
  });
}

function provenanceCapacityEvent(status: ProvenanceCapacitySignal["status"]): string {
  if (status === "alert") return "provenance.capacity.alert";
  if (status === "measurement-failed") return "provenance.capacity.measurement-failed";
  return "provenance.capacity.observation";
}

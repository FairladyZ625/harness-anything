import type { DaemonLogRepoContext, DaemonLogService } from "@harness-anything/application";
import {
  completeProvenanceCapacityObservation,
  readProvenanceLedgerScale,
  type ProvenanceCapacitySignal
} from "./provenance-capacity-trigger.ts";

export interface ProvenanceCapacityLogDisposition {
  readonly level: "info" | "warn";
  readonly event: string;
}

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
        const disposition = provenanceCapacityLogDisposition(signal.status);
        return daemonLogService.append({
          level: disposition.level,
          source: "daemon",
          component: "repo-write-child",
          event: disposition.event,
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
        const disposition = provenanceCapacityLogDisposition(fallbackStatus);
        return daemonLogService.append({
          level: disposition.level,
          source: "daemon",
          component: "repo-write-child",
          event: disposition.event,
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

export function provenanceCapacityLogDisposition(
  status: ProvenanceCapacitySignal["status"]
): ProvenanceCapacityLogDisposition {
  if (status === "alert") return { level: "warn", event: "provenance.capacity.alert" };
  if (status === "cold-start") return { level: "info", event: "provenance.capacity.cold-start" };
  if (status === "measurement-failed") {
    return { level: "warn", event: "provenance.capacity.measurement-failed" };
  }
  return { level: "info", event: "provenance.capacity.observation" };
}

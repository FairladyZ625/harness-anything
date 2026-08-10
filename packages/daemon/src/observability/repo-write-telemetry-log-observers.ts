import {
  repoWriteTelemetryBatchLogEvent,
  type DaemonLogRepoContext,
  type DaemonLogService
} from "@harness-anything/application";
import type {
  RepoWriteTelemetryBatchFrame,
  RepoWriteTelemetryFrame
} from "../runtime/repo-write-protocol.ts";
import { scheduleProvenanceCapacityLog } from "./provenance-capacity-log.ts";
import {
  createProvenanceCapacityTelemetryTrigger,
  type ProvenanceCapacitySignal
} from "./provenance-capacity-trigger.ts";
import { encodeRepoWriteTelemetryBatchLog } from "./repo-write-telemetry-log.ts";

export function createRepoWriteTelemetryLogObservers(input: {
  readonly daemonLogService: DaemonLogService;
  readonly context: DaemonLogRepoContext;
  readonly authoredGitRoot: string;
}): {
  readonly onTelemetry: (frame: RepoWriteTelemetryFrame) => void;
  readonly onTelemetryBatch: (frame: RepoWriteTelemetryBatchFrame) => void;
} {
  const capacity = createProvenanceCapacityTelemetryTrigger();
  const observeCapacity = (frame: RepoWriteTelemetryFrame): void => {
    scheduleCapacity(input, capacity.observe(frame));
  };
  return {
    onTelemetry: (frame) => {
      observeCapacity(frame);
      void input.daemonLogService.append({
        level: "debug",
        source: "daemon",
        component: "repo-write-child",
        event: "repo-write.request.telemetry",
        message: JSON.stringify({
          schema: "repo-write-request-telemetry/v1",
          requestId: frame.requestId,
          ...(frame.opId ? { opId: frame.opId } : {}),
          phase: frame.phase,
          elapsedMs: frame.elapsedMs,
          ...(frame.details ? { details: frame.details } : {})
        }),
        requestId: frame.requestId
      }, input.context).catch(() => undefined);
    },
    onTelemetryBatch: (batch) => {
      let capacitySignal: ProvenanceCapacitySignal | null = null;
      for (const span of batch.spans) {
        const frame: RepoWriteTelemetryFrame = {
          protocol: batch.protocol,
          repoId: batch.repoId,
          generation: batch.generation,
          kind: "telemetry",
          requestId: batch.requestId,
          ...(batch.opId ? { opId: batch.opId } : {}),
          ...span
        };
        capacitySignal = capacity.observe(frame) ?? capacitySignal;
      }
      scheduleCapacity(input, capacitySignal);
      void input.daemonLogService.append({
        level: "debug",
        source: "daemon",
        component: "repo-write-child",
        event: repoWriteTelemetryBatchLogEvent,
        message: encodeRepoWriteTelemetryBatchLog(batch),
        requestId: batch.requestId
      }, input.context).catch(() => undefined);
    }
  };
}

function scheduleCapacity(
  input: {
    readonly daemonLogService: DaemonLogService;
    readonly context: DaemonLogRepoContext;
    readonly authoredGitRoot: string;
  },
  signal: ProvenanceCapacitySignal | null
): void {
  if (!signal) return;
  scheduleProvenanceCapacityLog(
    input.daemonLogService,
    input.context,
    input.authoredGitRoot,
    signal
  );
}

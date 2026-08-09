import type {
  RepoWriteCommandDto,
  RepoWriteJsonObject,
  RepoWriteOperationLookupResult,
  RepoWriteTelemetryFrame
} from "./repo-write-protocol.ts";
import {
  beginRepoWriteParentPerformanceTiming,
  type RepoWriteParentPerformanceTiming
} from "./repo-write-parent-performance.ts";
import type { RepoWriteParentPendingPhase } from "./repo-write-phase.ts";

export interface PendingSubmit {
  readonly requestId: string;
  readonly command: RepoWriteCommandDto;
  readonly resolve: (receipt: RepoWriteJsonObject) => void;
  readonly reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
  phase: RepoWriteParentPendingPhase;
  opId?: string;
  lastTelemetry?: RepoWriteTelemetryFrame;
  readonly performanceTiming?: RepoWriteParentPerformanceTiming;
}

export interface PendingLookup {
  readonly requestId: string;
  readonly opId: string;
  readonly resolve: (result: RepoWriteOperationLookupResult) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  phase: "queued" | "sent";
  lastTelemetry?: RepoWriteTelemetryFrame;
  readonly performanceTiming?: RepoWriteParentPerformanceTiming;
}

export interface PendingShutdown {
  readonly requestId: string;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  sent: boolean;
}

export function createPendingRepoWriteSubmit(input: Pick<
  PendingSubmit,
  "requestId" | "command" | "resolve" | "reject"
>): PendingSubmit {
  return {
    ...input,
    timer: undefined,
    phase: "queued",
    performanceTiming: beginRepoWriteParentPerformanceTiming()
  };
}

export function createPendingRepoWriteLookup(input: Pick<
  PendingLookup,
  "requestId" | "opId" | "resolve" | "reject" | "timer"
>): PendingLookup {
  return {
    ...input,
    phase: "queued",
    performanceTiming: beginRepoWriteParentPerformanceTiming()
  };
}

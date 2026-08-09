import type { ReplicaChangeRecord } from "@harness-anything/application";
import type {
  AuthoritySnapshotManifestEntry,
  AuthoritySnapshotReservation
} from "../authority/protocol.ts";
import type { PersistentSshAuthorityClient } from "../transport/persistent-ssh-authority-client.ts";
import type { RetryBudgetSignal } from "../observability/visible-retry-budget.ts";

export interface RemoteReadDownBackoff {
  readonly initialMs: number;
  readonly maximumMs: number;
  readonly multiplier: number;
}

export interface RemoteReadDownChangeCacheLimits {
  readonly maxCount: number;
  readonly maxBytes: number;
}

export interface RemoteReadDownRetryBudget {
  readonly maxRetries: number;
  readonly reminderEveryFailures: number;
}

export interface RemoteReadDownSessionOptions {
  readonly client: PersistentSshAuthorityClient;
  readonly workspaceId: string;
  readonly stateRoot: string;
  readonly backoff?: Partial<RemoteReadDownBackoff>;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly schedule?: (milliseconds: number, callback: () => void) => { readonly dispose: () => void };
  readonly changeCache?: Partial<RemoteReadDownChangeCacheLimits>;
  readonly retryBudget?: Partial<RemoteReadDownRetryBudget>;
  readonly expectedResume?: ResumeCursor;
  readonly onDiagnostic?: (text: string) => void;
  readonly onRetryBudgetSignal?: (signal: RetryBudgetSignal) => void;
  readonly onTerminal?: (failure: Error) => void;
}

/**
 * Consumers must catch this error, persist a durable RESYNC transition, and
 * bootstrap from `cut`/`cutChange`, then acknowledge that bootstrap by retrying
 * `changesAfter(cut.revision)` before resuming incremental reads.
 * ReplicaChangeLog cannot mutate broker durable state on the consumer's behalf.
 */
export class RemoteReplicaResyncRequiredError extends Error {
  readonly cutChange: ReplicaChangeRecord | null;
  readonly cut: AuthoritySnapshotReservation["cut"];
  readonly cutRevision: number;

  constructor(
    message: string,
    cut: AuthoritySnapshotReservation["cut"],
    cutChange: ReplicaChangeRecord | null
  ) {
    super(`RESYNC_REQUIRED:${message}`);
    this.name = "RemoteReplicaResyncRequiredError";
    this.cut = cut;
    this.cutRevision = cut.revision;
    this.cutChange = cutChange;
  }
}

export interface ActiveSnapshot {
  readonly reservation: AuthoritySnapshotReservation;
  readonly cutChange: ReplicaChangeRecord | null;
  readonly baseEntries: ReadonlyMap<string, AuthoritySnapshotManifestEntry>;
  readonly changes: Map<number, ReplicaChangeRecord>;
  readonly changeSizes: Map<number, number>;
  readonly lossyHintRevisions: Set<number>;
  changeBytes: number;
  highestRevision: number;
  durableCursor: number;
  adopted: boolean;
  deliveredRevision: number;
  resyncReason?: string;
  resyncSignaled: boolean;
  resyncReported: boolean;
}

export interface ResumeCursor {
  readonly epoch: string;
  readonly deliveredRevision: number;
}

export type RemoteReadDownSessionHealth =
  | { readonly status: "IDLE" | "RECOVERING" | "READY" | "CLOSED" }
  | { readonly status: "TERMINAL"; readonly failure: Error };

export const defaultBackoff: RemoteReadDownBackoff = {
  initialMs: 100,
  maximumMs: 5_000,
  multiplier: 2
};

export const defaultChangeCache: RemoteReadDownChangeCacheLimits = {
  maxCount: 4_096,
  maxBytes: 8 * 1024 * 1024
};

export const defaultRetryBudget: RemoteReadDownRetryBudget = {
  maxRetries: 5,
  reminderEveryFailures: 5
};

export function assertBackoff(backoff: RemoteReadDownBackoff): void {
  if (!Number.isFinite(backoff.initialMs)
    || !Number.isFinite(backoff.maximumMs)
    || !Number.isFinite(backoff.multiplier)
    || backoff.initialMs < 0
    || backoff.maximumMs < backoff.initialMs
    || backoff.multiplier < 1) {
    throw new Error("remote read-down backoff must be finite, non-negative, and interval-capped");
  }
}

export function assertChangeCache(cache: RemoteReadDownChangeCacheLimits): void {
  if (!Number.isSafeInteger(cache.maxCount)
    || !Number.isSafeInteger(cache.maxBytes)
    || cache.maxCount < 1
    || cache.maxBytes < 1) {
    throw new Error("remote read-down change cache limits must be positive safe integers");
  }
}

export function assertRetryBudget(budget: RemoteReadDownRetryBudget): void {
  if (!Number.isSafeInteger(budget.maxRetries)
    || !Number.isSafeInteger(budget.reminderEveryFailures)
    || budget.maxRetries < 0
    || budget.reminderEveryFailures < 1) {
    throw new Error("remote read-down retry budget must use non-negative retries and positive reminders");
  }
}

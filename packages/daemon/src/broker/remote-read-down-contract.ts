import type { ReplicaChangeRecord } from "@harness-anything/application";
import type {
  AuthoritySnapshotManifestEntry,
  AuthoritySnapshotReservation
} from "../authority/protocol.ts";
import type { PersistentSshAuthorityClient } from "../transport/persistent-ssh-authority-client.ts";

export interface RemoteReadDownBackoff {
  readonly initialMs: number;
  readonly maximumMs: number;
  readonly multiplier: number;
}

export interface RemoteReadDownChangeCacheLimits {
  readonly maxCount: number;
  readonly maxBytes: number;
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
  readonly onDiagnostic?: (text: string) => void;
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

export const defaultBackoff: RemoteReadDownBackoff = {
  initialMs: 100,
  maximumMs: 5_000,
  multiplier: 2
};

export const defaultChangeCache: RemoteReadDownChangeCacheLimits = {
  maxCount: 4_096,
  maxBytes: 8 * 1024 * 1024
};

export function assertBackoff(backoff: RemoteReadDownBackoff): void {
  if (!Number.isFinite(backoff.initialMs)
    || !Number.isFinite(backoff.maximumMs)
    || !Number.isFinite(backoff.multiplier)
    || backoff.initialMs < 0
    || backoff.maximumMs < backoff.initialMs
    || backoff.multiplier < 1) {
    throw new Error("remote read-down backoff must be finite, non-negative, and bounded");
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

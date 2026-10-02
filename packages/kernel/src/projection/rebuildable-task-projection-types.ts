import type { CanonicalEventV1 } from "../domain/doc-sync.contract.ts";

// Source-stream and shared projection operation shapes.
export interface EventStreamPort {
  // The digest identifies the ledger a cache was scanned from; only catching-up owners supply it.
  readonly readHead: () => {
    readonly revision: number;
    readonly eventDigest?: `sha256:${string}`;
  } | null;
  readonly readBatch: (
    cursor: string | null,
    maxItems: number,
  ) => {
    readonly sourceRevision: number;
    readonly events: readonly CanonicalEventV1[];
    readonly cursor: string | null;
    readonly done: boolean;
    readonly accessedItems: number;
    readonly prefetchContent?: EventContentPrefetch;
  };
  readonly readContentBlob: (sha256: string) => Uint8Array | null;
}
export type EventContentPrefetch = (events: readonly CanonicalEventV1[]) => ReadonlyMap<string, Uint8Array | null>;
/** Per-round catch-up/rebuild progress: shared by incremental catch-up and full rebuilds so the
 * daemon watchdog can tell working-but-slow workers apart from wedged ones. */
export interface TaskProjectionCatchUpProgress {
  readonly applied: number;
  readonly total?: number;
  readonly watermark: number;
}
export interface ProjectionContext {
  readonly projectionPath: string;
  readonly readHead: EventStreamPort["readHead"];
  readonly eventStore: EventStreamPort;
  readonly limit: number;
  readonly now: () => string;
}

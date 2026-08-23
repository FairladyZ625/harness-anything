import type { CanonicalEventV1 } from "../domain/doc-sync.contract.ts";

// Source-stream and shared projection operation shapes.
export interface EventStreamPort {
  readonly readHead: () => {
    readonly revision: number;
    readonly eventDigest: `sha256:${string}`;
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
export interface ProjectionContext {
  readonly projectionPath: string;
  readonly readHead: EventStreamPort["readHead"];
  readonly eventStore: EventStreamPort;
  readonly limit: number;
  readonly now: () => string;
}

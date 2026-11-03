import type { CanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import type { CanonicalContentBlob } from "@harness-anything/kernel/internal/ports/task-event-store.ts";
import type { HarnessLayoutInput } from "@harness-anything/kernel/internal/layout/index.ts";
import type { ReplicationPosition, ReplicationCommit } from "./replication-log.ts";

export interface SqliteWriterFence {
  readonly repoId: string;
  readonly holder: string;
  readonly epoch: number;
}
export interface SqliteLedgerMetadata {
  readonly repoId: string;
  readonly generation: number;
  readonly revision: number;
}
export interface SqliteEventRow {
  readonly revision: number;
  readonly opId: string;
  readonly eventJson: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly digest: `sha256:${string}`;
}
/** The identity SQLite already durably stores for an event, without re-reading or re-serializing its body. */
export interface SqliteEventIdentity {
  readonly revision: number;
  readonly opId: string;
  readonly eventDigest: `sha256:${string}`;
}
export interface SqliteDocumentHead {
  readonly sha256: string;
  readonly size: number;
  readonly nodeKind: "file" | "symbolic-link";
}
export interface SqliteCommandIntent {
  readonly opId: string;
  readonly intentDigest: `sha256:${string}`;
  readonly summary: string;
}
export interface SqliteCommandOutcome {
  readonly opId: string;
  readonly status: "accepted_durable" | "rejected";
  readonly firstRevision: number | null;
  readonly lastRevision: number | null;
  readonly intentDigest: `sha256:${string}`;
  readonly summary: string;
  readonly rejectionCode: string | null;
  readonly recordedAt: string;
  readonly memberOpIds: readonly string[];
}
export type SqliteLedgerRevisionDifference = {
  readonly revision: number;
  readonly kind: "missing_in_sqlite" | "unexpected_in_sqlite" | "event_mismatch";
  readonly canonicalOpId: string | null;
  readonly sqliteOpId: string | null;
  readonly canonicalDigest: `sha256:${string}` | null;
  readonly sqliteDigest: `sha256:${string}` | null;
  readonly sqliteStoredDigest: string | null;
};
export interface SqliteLedgerReconciliation {
  readonly schema: "sqlite-ledger-reconciliation/v1";
  readonly repoId: string;
  readonly generation: number;
  readonly matches: boolean;
  readonly canonical: {
    readonly eventCount: number;
    readonly maxRevision: number;
    readonly distinctOpIds: number;
  };
  readonly sqlite: {
    readonly eventCount: number;
    readonly maxRevision: number;
    readonly distinctOpIds: number;
  };
  readonly firstDivergentRevision: number | null;
  readonly revisionDifferences: readonly SqliteLedgerRevisionDifference[];
  readonly opIdDifferences: {
    readonly missingInSqlite: readonly string[];
    readonly unexpectedInSqlite: readonly string[];
  };
}
export interface SqliteEventStore {
  readonly replicationPosition: () => ReplicationPosition;
  readonly pruneReplicationLog: (throughSequence: number) => void;
  readonly replicationCommits: (
    after: ReplicationPosition,
    limit: number,
  ) => {
    readonly commits: readonly ReplicationCommit[];
    readonly done: boolean;
    readonly head: ReplicationPosition;
  };
  readonly applyReplicationCommit: (
    commit: ReplicationCommit,
    blobs: readonly CanonicalContentBlob[],
  ) => ReplicationPosition;
  readonly databasePath: string;
  readonly sqliteVersion: string;
  readonly claimWriter: (fence: SqliteWriterFence) => void;
  /** Hand the ledger back when an offline holder stops writing, so a live writer is not fenced out. */
  readonly releaseWriter: (fence: SqliteWriterFence) => void;
  readonly writerFence: () => SqliteWriterFence | null;
  readonly appendCommand: (input: {
    readonly fence: SqliteWriterFence;
    readonly intent: SqliteCommandIntent;
    readonly events: readonly CanonicalEventV1[];
    readonly blobs?: readonly CanonicalContentBlob[];
    readonly rejectionCode?: string;
    readonly beforeOutcome?: () => void;
    readonly historicalRecord?: {
      readonly recordedAt: string;
      readonly eventRecordedAt: readonly string[];
    };
  }) => SqliteCommandOutcome;
  /** Internal admission seam: the caller has validated the canonical bundle before invoking this. */
  readonly appendValidatedBundle: (input: {
    readonly intent?: (eventBytes: readonly string[]) => SqliteCommandIntent;
    readonly fence: SqliteWriterFence;
    readonly events: readonly CanonicalEventV1[];
    readonly blobs: readonly CanonicalContentBlob[];
    readonly beforeOutcome?: () => void;
  }) => SqliteCommandOutcome;
  readonly outcome: (opId: string) => SqliteCommandOutcome | null;
  readonly readCommandOutcome: (opId: string) => SqliteCommandOutcome | null;
  readonly outcomes: () => readonly SqliteCommandOutcome[];
  readonly metadata: () => SqliteLedgerMetadata;
  readonly eventRows: () => readonly SqliteEventRow[];
  readonly eventRowPage: (
    afterRevision: number,
    limit: number,
  ) => {
    readonly rows: readonly SqliteEventRow[];
    readonly done: boolean;
  };
  readonly readContentObject: (sha256: string) => Uint8Array | null;
  readonly readContentObjectRange: (sha256: string, offset: number, maxBytes: number) => Uint8Array | null;
  readonly readContentObjectSize: (sha256: string) => number | null;
  readonly contentObjectDigests: () => readonly string[];
  readonly revision: () => number;
  readonly events: () => readonly CanonicalEventV1[];
  readonly event: (opId: string) => CanonicalEventV1 | null;
  readonly eventById: (eventId: string) => CanonicalEventV1 | null;
  readonly eventAtRevision: (revision: number) => CanonicalEventV1 | null;
  readonly eventIdentity: (opId: string) => SqliteEventIdentity | null;
  readonly headIdentity: () => SqliteEventIdentity | null;
  readonly eventIdentityAtRevision: (revision: number) => SqliteEventIdentity | null;
  readonly documentHead: (documentPath: string) => SqliteDocumentHead | "retired" | undefined;
  readonly eventsAfter: (revision: number, limit?: number) => readonly CanonicalEventV1[];
  readonly eventsBefore: (revision: number, limit?: number) => readonly CanonicalEventV1[];
  readonly attachMigrationScanWatermarks: () => ReadonlyMap<string, number>;
  readonly recordAttachMigrationScanWatermarks: (
    watermarks: readonly { readonly migration: string; readonly revision: number }[],
  ) => void;
  readonly queryEvents: (input: {
    readonly type?: string;
    readonly entity?: string;
    readonly actor?: string;
    readonly after?: string;
    readonly before?: string;
    readonly revisionBound?: number;
    readonly limit: number;
  }) => readonly CanonicalEventV1[];
  readonly close: () => void;
}
export interface GenerationTwoActivationV2 {
  readonly schema: "generation-activation/v2";
  readonly repoId: string;
  readonly sourceDigest: string;
  readonly importedPrefixRevision: number;
  readonly generation: 2;
}
export type SqliteEventStoreOpenOptions = {
  readonly repoId?: string;
  readonly rootInput?: HarnessLayoutInput;
  readonly databasePath?: string;
  readonly generation?: number;
  readonly readOnly?: boolean;
  /** Offline generation conversion only; ordinary writers cannot backfill acceptance time. */
  readonly conversionSourceGeneration?: 1 | 2;
  readonly migrationImportRunId?: string;
  readonly onOpenProgress?: (progress: { readonly applied: number; readonly total: number }) => void;
};

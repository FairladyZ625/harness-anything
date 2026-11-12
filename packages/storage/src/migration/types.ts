import type * as OperationalStatus from "@harness-anything/kernel/internal/domain/operational-status.ts";
import type { LedgerCutIdentity } from "@harness-anything/kernel/internal/domain/write-chain.contract.ts";
import type { PostgresEventStoreScope } from "../postgres/pg-event-store.ts";
import type { SqliteCommandOutcome, SqliteEventRow } from "../store/sqlite-event-store.ts";

export type MigrationPhase = OperationalStatus.MigrationPhase;
export interface StorageMigrationRecord {
  readonly runId: string;
  readonly source: string;
  readonly target: string;
  readonly role: "source" | "target";
  readonly phase: MigrationPhase;
  readonly epoch: number;
  readonly cut: LedgerCutIdentity;
  readonly tupleCuts?: readonly {
    readonly tenantId: string;
    readonly projectId: string;
    readonly cut: LedgerCutIdentity;
  }[];
}
export interface MigrationEvent extends SqliteEventRow {
  readonly readers: readonly string[];
  readonly policyEpoch: number;
}
export interface MigrationBlob {
  readonly sha256: string;
  readonly size: number;
  readonly bodyBase64: string;
  readonly readers: readonly string[];
  readonly policyEpoch: number;
}
export interface MigrationTuple {
  readonly scope: PostgresEventStoreScope;
  readonly cut: LedgerCutIdentity;
  readonly events: readonly MigrationEvent[];
  readonly outcomes: readonly (SqliteCommandOutcome & {
    readonly readers: readonly string[];
    readonly policyEpoch: number;
  })[];
  readonly blobs: readonly MigrationBlob[];
  readonly documentHeads: readonly {
    readonly path: string;
    readonly sha256: string | null;
    readonly size: number | null;
    readonly nodeKind: string | null;
    readonly revision: number;
    readonly readers: readonly string[];
    readonly policyEpoch: number;
  }[];
  readonly projection: unknown;
}
export interface StorageMigrationManifest {
  readonly schema: "storage-migration/v1";
  readonly versions: {
    readonly eventSchema: 1;
    readonly reducer: 1;
    readonly projection: number;
    readonly sqliteProjection: number;
  };
  readonly repoId: string;
  readonly runId: string;
  readonly source: string;
  readonly target: string;
  readonly tuples: readonly MigrationTuple[];
}
export { StorageMigrationError } from "@harness-anything/kernel/internal/domain/storage-scope-policy.ts";
export function migrationWritable(record: StorageMigrationRecord | null): boolean {
  return (
    record === null ||
    record.phase === "source_resumed" ||
    (record.role === "target" && record.phase === "target_activated")
  );
}
export interface MigrationEndpoint {
  readonly id: string;
  readonly backend: "sqlite" | "postgres" | "pglite";
  readonly state: () => Promise<StorageMigrationRecord | null>;
  readonly marker: (runId: string) => Promise<boolean>;
  readonly change: (
    expected: StorageMigrationRecord | null,
    next: StorageMigrationRecord,
    activate?: boolean,
  ) => Promise<void>;
  readonly export: (runId: string) => Promise<readonly MigrationTuple[]>;
  readonly import: (manifest: StorageMigrationManifest) => Promise<void>;
  readonly epoch: () => Promise<number>;
  readonly close: () => Promise<void>;
}

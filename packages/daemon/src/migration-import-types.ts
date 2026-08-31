import {
  type CanonicalWriteBundle,
  type MigrationDestinationPreimage,
  type MigrationImportEventV1,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import type { TaskContractRestatementCounts } from "./migration-import-task-restatement.ts";
import type { MigrationOracleKind } from "./migration-import-oracle.ts";

export type EntityKind =
  | "task"
  | "decision"
  | "fact"
  | "relation"
  | "agent"
  | "schedule"
  | "runtime-session"
  | "coverage";

export interface Skip {
  readonly entityType: EntityKind;
  readonly migratedFrom: string;
  readonly sourcePath: string;
  readonly reason: string;
  readonly coverage?: number;
}

export interface MigrationFieldDerivation {
  readonly entityType: MigrationOracleKind;
  readonly entityId: string;
  readonly field: string;
  readonly derived_from: string;
}

export interface MigrationDisposition {
  readonly entityType: MigrationOracleKind;
  readonly entityId: string;
  readonly sourcePath: string;
  readonly disposition: "archived" | "retired";
  readonly reason: "truth_gap";
}

export interface MigrationKindReconciliation {
  readonly source: number;
  readonly target: number;
  readonly difference: number;
  readonly derived: number;
  readonly archived: number;
  readonly retired: number;
  readonly missingIds: readonly string[];
  readonly passed: boolean;
}

export interface MigrationOracleBasis {
  readonly kind: "same-cut-projection" | "rebuilt-source";
  readonly databasePath: string;
  readonly watermark: number;
  readonly eventHeadRevision: number | null;
}

export interface MigrationFormatObservation {
  readonly code: "legacy_event_normalized" | "schedule_definition_facet_mismatch" | "source_projection_rebuilt";
  readonly sourcePath: string;
  readonly detail: string;
  readonly treatment: "mechanically_normalized" | "accepted_truth_gap" | "rebuilt_read_only";
}

export interface Draft {
  readonly kind: Exclude<EntityKind, "coverage">;
  readonly migratedFrom: string;
  readonly occurredAt: string;
  readonly build: (revision: number) => Prepared;
}

export type Prepared = CanonicalWriteBundle;

export interface PackageDraft {
  readonly migratedFrom: string;
  readonly occurredAt: string;
  readonly build: (revision: number) => Prepared;
}

export interface ImportCounts {
  readonly task: number;
  readonly decision: number;
  readonly fact: number;
  readonly relation: number;
  readonly agent: number;
  readonly schedule: number;
  readonly "runtime-session": number;
  readonly coverage: number;
}

export interface MigrationBackfillRow {
  readonly entityType: "agent" | "schedule" | "runtime-session";
  readonly entityId: string;
  readonly action: "create" | "unchanged" | "conflict";
  readonly sourceAnchor: string;
}

export type AuthoredDisposition = "migrated" | "excluded" | "required";

export type ResolutionChoice = "destination" | "source";

export type AuthoredNode = MigrationDestinationPreimage & {
  readonly linkTarget?: string;
};

export type DestinationNode = AuthoredNode | { readonly nodeKind: "directory" };

export interface AuthoredClassification {
  readonly surface: string;
  readonly disposition: AuthoredDisposition;
  readonly reason: string;
  readonly targetConflict?: true;
  readonly resolution?: ResolutionChoice;
  readonly destinationPreimage?: MigrationDestinationPreimage;
  readonly mergedBody?: string;
}

export interface AuthoredCoverageRow {
  readonly surface: string;
  readonly disposition: AuthoredDisposition;
  readonly old: number;
  readonly reason: string;
  readonly samples: readonly string[];
}

export interface AuthoredCoverage {
  readonly passed: boolean;
  readonly counts: Readonly<Record<AuthoredDisposition, number>>;
  readonly rows: readonly AuthoredCoverageRow[];
}

export interface SourceGitIdentity {
  readonly sourceId: string;
  readonly rootCommit: string;
  readonly head: string;
  readonly tree: string;
}

export interface IdRemapping {
  readonly entityType: "task" | "decision" | "fact";
  readonly sourceId: string;
  readonly targetId: string;
  readonly reason: string;
}

export type MigrationImportReceipt = WriteReceipt & {
  readonly summary: string;
  readonly mode: "dry-run" | "apply";
  readonly exitCode: 0 | 1 | 3;
  readonly counts: {
    readonly old: ImportCounts;
    readonly skipped: ImportCounts;
    readonly expected: ImportCounts;
    readonly new: ImportCounts;
  };
  readonly contractRestatements: { readonly task: TaskContractRestatementCounts };
  readonly oracle: MigrationOracleBasis;
  readonly reconciliation: Readonly<Record<MigrationOracleKind, MigrationKindReconciliation>>;
  readonly fieldDerivations: readonly MigrationFieldDerivation[];
  readonly dispositions: readonly MigrationDisposition[];
  readonly formatObservations: readonly MigrationFormatObservation[];
  readonly authoredCoverage: AuthoredCoverage;
  readonly skippedEntities: readonly Skip[];
  readonly idMapPath: string | null;
  readonly backfillMapPath: string | null;
  readonly backfillRows: readonly MigrationBackfillRow[];
};

export type ImportedTask = Extract<MigrationImportEventV1["payload"]["entity"], { readonly kind: "task" }>["task"];

export type ImportedRelation = Extract<
  MigrationImportEventV1["payload"]["entity"],
  { readonly kind: "relation" }
>["relation"];

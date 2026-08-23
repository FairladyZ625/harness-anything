import {
  migrationImportWritePlan,
  type MigrationDestinationPreimage,
  type MigrationImportEventV1,
  type WriteReceipt,
} from "../../kernel/src/index.ts";

export type EntityKind = "task" | "decision" | "fact" | "relation" | "coverage";

export interface Skip {
  readonly entityType: EntityKind;
  readonly migratedFrom: string;
  readonly sourcePath: string;
  readonly reason: string;
  readonly coverage?: number;
}

export interface Draft {
  readonly kind: Exclude<EntityKind, "coverage">;
  readonly migratedFrom: string;
  readonly occurredAt: string;
  readonly build: (revision: number) => Prepared;
}

export interface Prepared {
  readonly event: MigrationImportEventV1;
  readonly plan: ReturnType<typeof migrationImportWritePlan>;
  readonly blobs: readonly {
    readonly sha256: string;
    readonly size: number;
    readonly mediaType: string;
    readonly body: string;
  }[];
}

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
  readonly coverage: number;
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
  readonly authoredCoverage: AuthoredCoverage;
  readonly skippedEntities: readonly Skip[];
  readonly idMapPath: string | null;
};

export type ImportedTask = Extract<MigrationImportEventV1["payload"]["entity"], { readonly kind: "task" }>["task"];

export type ImportedRelation = Extract<
  MigrationImportEventV1["payload"]["entity"],
  { readonly kind: "relation" }
>["relation"];

import { DecisionPackageSchema, EntityRelationRecordSchema, FactRecordSchema, TaskFrontmatterSchema } from "../schemas/registry.ts";
import {
  decisionFieldContracts,
  factFieldContracts,
  relationFieldContracts,
  taskFieldContracts,
  type DecisionFieldKey,
  type EntityFieldContract,
  type FactFieldKey,
  type RelationFieldKey,
  type TaskFieldKey
} from "./field-contracts.ts";

export type KernelEntityKind = "decision" | "task" | "fact" | "relation";
export type EntityStorageForm = "lifecycle" | "schema" | "composite" | "host_frontmatter";
export type DispositionLevel = "D1" | "D2" | "D3" | "D4";
export type DispositionAction =
  | "retire"
  | "supersede"
  | "invalidate"
  | "archive"
  | "tombstone"
  | "hard-delete";

export interface EntityAnchorDeclaration {
  readonly entityRef: string;
  readonly anchors: ReadonlyArray<{
    readonly field: string;
    readonly idField: string;
    readonly ref: string;
  }>;
}

export interface DispositionMatrixEntry {
  readonly level: DispositionLevel;
  readonly action: DispositionAction;
  readonly supported: boolean;
  readonly writeOpKinds: ReadonlyArray<string>;
  readonly reason: string;
}

export interface EntityDispositionMatrix {
  readonly entries: Readonly<Record<DispositionAction, DispositionMatrixEntry>>;
}

export interface EntityRegistration<FieldKey extends string> {
  readonly kind: KernelEntityKind;
  readonly schema: unknown;
  readonly mutabilityContract: Readonly<Record<FieldKey, EntityFieldContract>>;
  readonly anchors: EntityAnchorDeclaration;
  readonly dispositionMatrix: EntityDispositionMatrix;
  readonly storageForm: EntityStorageForm;
}

export type EntityRegistryShape = {
  readonly decision: EntityRegistration<DecisionFieldKey>;
  readonly task: EntityRegistration<TaskFieldKey>;
  readonly fact: EntityRegistration<FactFieldKey>;
  readonly relation: EntityRegistration<RelationFieldKey>;
};

export const entityRegistry = {
  decision: {
    kind: "decision",
    schema: DecisionPackageSchema,
    mutabilityContract: decisionFieldContracts,
    anchors: {
      entityRef: "decision/{decision_id}",
      anchors: [
        { field: "claims", idField: "id", ref: "decision/{decision_id}/{id}" },
        { field: "chosen", idField: "id", ref: "decision/{decision_id}/{id}" },
        { field: "rejected", idField: "id", ref: "decision/{decision_id}/{id}" }
      ]
    },
    dispositionMatrix: dispositionMatrix([
      supported("D1", "retire", ["decision_retire"], "decision semantic retirement preserves organizational memory"),
      supported("D1", "supersede", ["decision_supersede"], "decision correction is expressed as supersession"),
      unsupported("D1", "invalidate", "decision invalidation is modeled as retire or supersede"),
      unsupported("D2", "archive", "decision archive/version-rollup is declared but not writable in M5 F5"),
      unsupported("D3", "tombstone", "bad proposed decisions are rejected, not tombstoned"),
      unsupported("D4", "hard-delete", "decision is why-memory and must never be physically deleted")
    ]),
    storageForm: "lifecycle"
  },
  task: {
    kind: "task",
    schema: TaskFrontmatterSchema,
    mutabilityContract: taskFieldContracts,
    anchors: {
      entityRef: "task/{task_id}",
      anchors: []
    },
    dispositionMatrix: dispositionMatrix([
      supported("D1", "supersede", ["package_supersede"], "task replacement is expressed as supersession"),
      unsupported("D1", "retire", "task semantic retirement uses supersede in the current task surface"),
      unsupported("D1", "invalidate", "task invalidation is not a task disposition action"),
      supported("D2", "archive", ["package_archive"], "task archive exits the work view while preserving the package"),
      supported("D3", "tombstone", ["package_tombstone"], "task tombstone preserves id existence after mistaken creation"),
      supported("D4", "hard-delete", ["package_delete_hard"], "task hard delete is allowed only after lower-bound checks and explicit confirmation")
    ]),
    storageForm: "lifecycle"
  },
  fact: {
    kind: "fact",
    schema: FactRecordSchema,
    mutabilityContract: factFieldContracts,
    anchors: {
      entityRef: "fact/{task_id}/{fact_id}",
      anchors: []
    },
    dispositionMatrix: dispositionMatrix([
      supported("D1", "invalidate", ["fact_invalidate"], "fact is append-only; invalidation is represented by an active invalidating relation"),
      unsupported("D1", "retire", "fact semantic exit is invalidate, not retire"),
      unsupported("D1", "supersede", "fact supersession uses a relation edge and remains an invalidation-class D1 action"),
      unsupported("D2", "archive", "fact follows its owner task archive and is not archived singly"),
      unsupported("D3", "tombstone", "fact is append-only and has no single-record tombstone semantics"),
      unsupported("D4", "hard-delete", "fact must never be physically deleted as a standalone entity")
    ]),
    storageForm: "schema"
  },
  relation: {
    kind: "relation",
    schema: EntityRelationRecordSchema,
    mutabilityContract: relationFieldContracts,
    anchors: {
      entityRef: "relation/{relation_id}",
      anchors: []
    },
    dispositionMatrix: dispositionMatrix([
      supported("D1", "retire", ["relation_retire"], "relation semantic retirement preserves the hosted edge record while removing it from active graph semantics"),
      unsupported("D1", "supersede", "relation replacement is modeled as retire old edge plus append new edge"),
      unsupported("D1", "invalidate", "relation invalidation is modeled as retire or replacing the edge"),
      unsupported("D2", "archive", "relation storage is hosted in source frontmatter and follows the host document"),
      unsupported("D3", "tombstone", "relation exit is represented by retired state, not tombstone"),
      unsupported("D4", "hard-delete", "relation records are provenance-bearing and are not physically deleted")
    ]),
    storageForm: "host_frontmatter"
  }
} satisfies EntityRegistryShape;

export const entityRegistryKinds = Object.keys(entityRegistry) as ReadonlyArray<KernelEntityKind>;

export function getEntityRegistration(kind: KernelEntityKind): EntityRegistryShape[typeof kind] {
  return entityRegistry[kind];
}

function dispositionMatrix(entries: ReadonlyArray<DispositionMatrixEntry>): EntityDispositionMatrix {
  const byAction = Object.fromEntries(entries.map((entry) => [entry.action, entry])) as Readonly<Record<DispositionAction, DispositionMatrixEntry>>;
  return { entries: byAction };
}

function supported(
  level: DispositionLevel,
  action: DispositionAction,
  writeOpKinds: ReadonlyArray<string>,
  reason: string
): DispositionMatrixEntry {
  return { level, action, supported: true, writeOpKinds, reason };
}

function unsupported(level: DispositionLevel, action: DispositionAction, reason: string): DispositionMatrixEntry {
  return { level, action, supported: false, writeOpKinds: [], reason };
}

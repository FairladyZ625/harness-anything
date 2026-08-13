import { EntityRelationRecordSchema, FactEventSchema, TaskFrontmatterSchema } from "../schemas/registry.ts";
import { DecisionEventSchema } from "../schemas/fact-event.ts";
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
import { sessionEntityRegistration } from "./session-declaration.ts";

export type KernelEntityKind = "decision" | "task" | "fact" | "relation" | "session";
export const entityStorageForms = [
  "lifecycle",
  "schema",
  "composite",
  "host_frontmatter",
  "hosted-entity",
  "composite-manifest-blob"
] as const;
export type EntityStorageForm = (typeof entityStorageForms)[number];
export type DispositionLevel = "D1" | "D2" | "D3" | "D4";
export type DispositionAction =
  | "retire"
  | "supersede"
  | "invalidate"
  | "archive"
  | "tombstone"
  | "hard-delete";

export interface HostedEntityDeclaration {
  readonly entityKind: string;
  readonly pathTemplate: string;
  readonly identity: ReadonlyArray<string>;
}

export interface EntityRootResolverDeclaration {
  readonly pathTemplate: string;
  readonly identity: ReadonlyArray<string>;
  readonly host?: HostedEntityDeclaration;
}

export interface EntityProjectionColumnDeclaration {
  readonly name: string;
  readonly field: string;
  readonly type: "text" | "integer" | "boolean" | "json";
  readonly primaryKey?: boolean;
}

export interface EntityProjectionDeclaration {
  readonly table: string;
  readonly columns: ReadonlyArray<EntityProjectionColumnDeclaration>;
}

export interface EntityDocumentCodec {
  readonly decode: (body: string) => unknown;
  readonly encode: (value: unknown) => string;
}

export interface CompositeManifestBlobDeclaration {
  readonly referenceField: string;
  readonly store: "content-addressed";
}

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

export interface EntityRegistration<FieldKey extends string, Kind extends string = KernelEntityKind> {
  readonly kind: Kind;
  readonly schema: unknown;
  readonly mutabilityContract: Readonly<Record<FieldKey, EntityFieldContract>>;
  readonly anchors: EntityAnchorDeclaration;
  readonly dispositionMatrix: EntityDispositionMatrix;
  readonly storageForm: EntityStorageForm;
  readonly rootResolver?: EntityRootResolverDeclaration;
  readonly projection?: EntityProjectionDeclaration;
  readonly documentCodec?: EntityDocumentCodec;
  readonly blob?: CompositeManifestBlobDeclaration;
}

export type EntityRegistryShape = {
  readonly decision: EntityRegistration<DecisionFieldKey>;
  readonly task: EntityRegistration<TaskFieldKey>;
  readonly fact: EntityRegistration<FactFieldKey>;
  readonly relation: EntityRegistration<RelationFieldKey>;
  readonly session: typeof sessionEntityRegistration;
};

export const entityRegistry = {
  decision: {
    kind: "decision",
    schema: DecisionEventSchema,
    mutabilityContract: decisionFieldContracts,
    anchors: {
      entityRef: "decision/{decisionId}",
      anchors: [
        { field: "claims", idField: "claimId", ref: "decision/{decisionId}/{claimId}" },
        { field: "chosen", idField: "id", ref: "decision/{decisionId}/{id}" },
        { field: "rejected", idField: "id", ref: "decision/{decisionId}/{id}" }
      ]
    },
    dispositionMatrix: dispositionMatrix([
      supported("D1", "retire", ["decision_retired"], "decision semantic retirement preserves organizational memory"),
      supported("D1", "supersede", ["decision_related"], "decision correction is expressed as a supersedes relation"),
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
      unsupported("D1", "supersede", "replay/v1 does not expose authored task package disposition writes"),
      unsupported("D1", "retire", "replay/v1 does not expose authored task package disposition writes"),
      unsupported("D1", "invalidate", "task invalidation is not a task disposition action"),
      unsupported("D2", "archive", "replay/v1 does not expose authored task package disposition writes"),
      unsupported("D3", "tombstone", "replay/v1 does not expose authored task package disposition writes"),
      unsupported("D4", "hard-delete", "replay/v1 does not expose authored task package disposition writes")
    ]),
    storageForm: "lifecycle"
  },
  fact: {
    kind: "fact",
    schema: FactEventSchema,
    mutabilityContract: factFieldContracts,
    anchors: {
      entityRef: "fact/{task_id}/{fact_id}",
      anchors: []
    },
    dispositionMatrix: dispositionMatrix([
      supported("D1", "invalidate", ["fact_recorded"], "fact is append-only; invalidation is represented by a superseding Fact event"),
      unsupported("D1", "retire", "fact semantic exit is invalidate, not retire"),
      unsupported("D1", "supersede", "fact supersession uses a relation edge and remains an invalidation-class D1 action"),
      unsupported("D2", "archive", "fact follows its owner task archive and is not archived singly"),
      unsupported("D3", "tombstone", "fact is append-only and has no single-record tombstone semantics"),
      unsupported("D4", "hard-delete", "fact must never be physically deleted as a standalone entity")
    ]),
    storageForm: "lifecycle"
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
  },
  session: sessionEntityRegistration
} satisfies EntityRegistryShape;

export const entityRegistryKinds = Object.keys(entityRegistry) as ReadonlyArray<KernelEntityKind>;

export function getEntityRegistration(kind: KernelEntityKind): EntityRegistryShape[typeof kind] {
  return entityRegistry[kind];
}

export function isEntityStorageForm(value: unknown): value is EntityStorageForm {
  return typeof value === "string" && (entityStorageForms as ReadonlyArray<string>).includes(value);
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

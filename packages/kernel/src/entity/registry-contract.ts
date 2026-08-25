import type { EntityFieldContract } from "./field-contracts.ts";

export type KernelEntityKind = "decision" | "task" | "fact" | "relation" | "session";
export const entityStorageForms = [
  "lifecycle",
  "schema",
  "composite",
  "host_frontmatter",
  "hosted-entity",
  "composite-manifest-blob",
] as const;
export type EntityStorageForm = (typeof entityStorageForms)[number];
export type DispositionLevel = "D1" | "D2" | "D3" | "D4";
export type DispositionAction = "retire" | "supersede" | "invalidate" | "archive" | "tombstone" | "hard-delete";

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
  readonly anchors: ReadonlyArray<{ readonly field: string; readonly idField: string; readonly ref: string }>;
}
export interface EmbeddedCanonicalEventDeclaration {
  readonly schema: string;
  readonly types: ReadonlyArray<string>;
  readonly payloadField: string;
}
export interface EntityCanonicalProjectionDeclaration {
  readonly embeddedEvents: ReadonlyArray<EmbeddedCanonicalEventDeclaration>;
  readonly row: {
    readonly idField: string;
    readonly ownerField: string | null;
  };
}
export interface EntityRelationProjectionDeclaration {
  readonly source: {
    readonly field: string;
    readonly refTemplate: string;
  };
  readonly target: {
    readonly field: string;
    readonly refTemplate: string;
  };
  readonly direction: "directed";
  readonly strength: "strong" | "weak";
  readonly origin: "generated" | "inferred";
  readonly rationale: string;
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

export function dispositionMatrix(entries: ReadonlyArray<DispositionMatrixEntry>): EntityDispositionMatrix {
  return {
    entries: Object.fromEntries(entries.map((entry) => [entry.action, entry])) as Readonly<
      Record<DispositionAction, DispositionMatrixEntry>
    >,
  };
}
export function supported(
  level: DispositionLevel,
  action: DispositionAction,
  writeOpKinds: ReadonlyArray<string>,
  reason: string,
): DispositionMatrixEntry {
  return { level, action, supported: true, writeOpKinds, reason };
}
export function unsupported(
  level: DispositionLevel,
  action: DispositionAction,
  reason: string,
): DispositionMatrixEntry {
  return { level, action, supported: false, writeOpKinds: [], reason };
}
export function isEntityStorageForm(value: unknown): value is EntityStorageForm {
  return typeof value === "string" && (entityStorageForms as ReadonlyArray<string>).includes(value);
}

import type { EntityFieldContract } from "./field-contracts.ts";

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

export type EntityIdentity = Readonly<Record<string, string>>;
export type EntityStorageContext = Readonly<Record<string, string>>;

export interface EntityIdentityCodec {
  readonly encode: (identity: EntityIdentity) => string;
  readonly decode: (canonicalRef: string) => EntityIdentity;
}

export interface StorageTarget {
  readonly kind: "document" | "content-addressed-blob";
  readonly path?: string;
  readonly access: "exact" | "prefix";
  readonly referenceField?: string;
}

export interface LocatedEntityStorage {
  readonly targets: ReadonlyArray<StorageTarget>;
  readonly consistencyScope: string;
}

export interface EntityStorageLocator {
  readonly locate: (identity: EntityIdentity, context: EntityStorageContext) => LocatedEntityStorage;
}

export interface DeferredRegistryFacet {
  readonly status: "deferred";
  readonly owner: string;
  readonly reason: string;
}

export interface ReadyIdentityCodecFacet {
  readonly status: "ready";
  readonly codec: EntityIdentityCodec;
}

export interface ReadyStorageLocatorFacet {
  readonly status: "ready";
  readonly locator: EntityStorageLocator;
}

export interface ReadyMutationContractFacet {
  readonly status: "ready";
  readonly actions: ReadonlyArray<string>;
}

export type SectionWriteMode = "free-prose" | "machine-written" | "forbidden";
export type SemanticRegionClass = "host-prose-only" | "entity-bearing";

export interface SemanticDiffSectionPolicy {
  readonly anchor: string;
  readonly writeMode: SectionWriteMode;
  readonly semanticClass?: SemanticRegionClass;
}

export interface SemanticDiffDocumentPolicy {
  readonly path: string;
  readonly sections: ReadonlyArray<SemanticDiffSectionPolicy>;
  readonly undeclaredSections?: "allow" | "reject";
}

export interface SemanticDiffCandidateDocument {
  readonly path: string;
  readonly body: string | null;
}

export interface SemanticDiffCandidateTree {
  readonly documents: ReadonlyArray<SemanticDiffCandidateDocument>;
}

export interface SemanticDiffCompileContext {
  readonly documentPolicies: ReadonlyArray<SemanticDiffDocumentPolicy>;
}

export interface SemanticDiffMutationIntent {
  readonly entityKind: string;
  readonly identity: EntityIdentity;
  readonly action: string;
  readonly storageContext?: EntityStorageContext;
  readonly additionalStorageContexts?: ReadonlyArray<EntityStorageContext>;
}

export interface ReadySemanticDiffFacet {
  readonly status: "ready";
  readonly compile: (
    base: SemanticDiffCandidateTree,
    candidate: SemanticDiffCandidateTree,
    context: SemanticDiffCompileContext
  ) => ReadonlyArray<SemanticDiffMutationIntent>;
}

export interface TypedOnlySemanticDiffFacet {
  readonly status: "typed-only";
  readonly reason: string;
}

export interface ReadyProjectionFacet {
  readonly status: "ready";
  readonly project: (entity: unknown) => unknown;
  readonly resolveCanonicalRef: (canonicalRef: string) => EntityIdentity;
  readonly attributionTarget?: {
    readonly table: string;
    readonly idColumn: string;
    readonly identityField: string;
    readonly materialization?: "existing-entity-table" | "mutation-index";
  };
}

export type IdentityCodecFacet = ReadyIdentityCodecFacet | DeferredRegistryFacet;
export type StorageLocatorFacet = ReadyStorageLocatorFacet | DeferredRegistryFacet;
export type MutationContractFacet = ReadyMutationContractFacet | DeferredRegistryFacet;
export type SemanticDiffFacet = ReadySemanticDiffFacet | TypedOnlySemanticDiffFacet | DeferredRegistryFacet;
export type ProjectionFacet = ReadyProjectionFacet | DeferredRegistryFacet;

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

export interface EntityRegistration<FieldKey extends string, Kind extends string = string> {
  readonly kind: Kind;
  readonly schema: unknown;
  readonly mutabilityContract: Readonly<Record<FieldKey, EntityFieldContract>>;
  readonly anchors: EntityAnchorDeclaration;
  readonly dispositionMatrix: EntityDispositionMatrix;
  readonly storageForm: EntityStorageForm;
  readonly identityCodec: IdentityCodecFacet;
  readonly storageLocator: StorageLocatorFacet;
  readonly mutationContract: MutationContractFacet;
  readonly semanticDiff: SemanticDiffFacet;
  readonly projectionFacet: ProjectionFacet;
  readonly rootResolver?: EntityRootResolverDeclaration;
  readonly projection?: EntityProjectionDeclaration;
  readonly documentCodec?: EntityDocumentCodec;
  readonly blob?: CompositeManifestBlobDeclaration;
}

export function isEntityStorageForm(value: unknown): value is EntityStorageForm {
  return typeof value === "string" && (entityStorageForms as ReadonlyArray<string>).includes(value);
}

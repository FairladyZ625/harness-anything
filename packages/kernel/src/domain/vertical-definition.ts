import { relationTypes } from "./entity-relation.ts";

/**
 * Pure decoded shape of a vertical definition. The domain consumes these values only after the
 * schema layer has decoded and accepted the raw input; the schema module anchors its decoded type
 * to the shapes below at compile time, so drift between the two fails the type check here.
 */
export const artifactLocatorKinds = Object.freeze(["repository-path", "url", "external-key"] as const);
export type ArtifactLocatorKind = (typeof artifactLocatorKinds)[number];

export interface VerticalTemplateLocalePolicy {
  readonly prefer: "project" | "preset" | "explicit";
  readonly fallback: "zh-CN" | "en-US";
}

export interface VerticalTemplateSelection {
  readonly slot: string;
  readonly templateRef: string;
  readonly materializeAs: string;
  readonly localePolicy: VerticalTemplateLocalePolicy;
  readonly requiredWhen?: Readonly<Record<string, string>>;
}

export interface VerticalSeededDoc extends VerticalTemplateSelection {
  readonly overwrite?: boolean;
}

/** AGENTS.md three-layer composite slot; composition lives in the CLI materializer. */
export interface VerticalAgentsEntry {
  readonly materializeAs: string;
  readonly localePolicy: VerticalTemplateLocalePolicy;
  readonly baseRef: string;
  readonly overlayRef: string;
  readonly repoSpecificsAnchor?: string;
  readonly overwrite?: boolean;
}

export interface VerticalRepositoryScaffold {
  readonly entityRoots: readonly {
    readonly entityKind: string;
    readonly path: string;
    readonly create: "init" | "lazy";
  }[];
  readonly dirs: readonly { readonly path: string; readonly create: "init" | "lazy" }[];
  readonly seededDocs: readonly VerticalSeededDoc[];
  readonly agentsEntry?: VerticalAgentsEntry;
}

export interface VerticalScript {
  readonly id: string;
  readonly type: "script";
  readonly command: string;
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly inputs: Readonly<Record<string, string>>;
  readonly metadata: {
    readonly description: string;
    readonly purpose: "scaffold" | "generate" | "transform" | "audit";
    readonly kind?: "action" | "check";
    readonly contractVersion: "script-entry/v1";
    readonly produces: readonly string[];
  };
}

export interface VerticalEntityFieldExtension {
  readonly extends: "task";
  readonly field: string;
  readonly kind: "enum-facet";
  readonly values: readonly string[];
  readonly default: null;
  readonly mutability: "amendable";
  readonly projection: { readonly column: string; readonly queryable: boolean };
  readonly reason: string;
}

export type VerticalRelationType = (typeof relationTypes)[number];

export interface ArtifactRelationDefinition {
  readonly type: VerticalRelationType;
  readonly sourceKind: string;
  readonly targetKind: string;
  readonly reads: string;
  readonly strength: "weak" | "strong";
  readonly rationale?: string;
  readonly decisionClaimRef: string;
  readonly decisionContentPin: string;
}

/** One declared attribute of an Artifact kind: pure values a form control can generate. */
export interface EntityAttributeDeclaration {
  readonly type: "string" | "number" | "integer" | "boolean";
  readonly enum?: readonly string[];
  readonly required?: boolean;
}

export interface EntityKindSchemaVersion {
  readonly version: number;
  readonly attributes: Readonly<Record<string, EntityAttributeDeclaration>>;
}

export interface VerticalLifecycleKindDeclaration {
  readonly retired?: boolean;
  readonly retiredAt?: string;
  readonly reason?: string;
  readonly id: string;
  readonly entityType: "lifecycle";
  readonly packageKind: string;
  readonly contractEntity: boolean;
}

export interface VerticalSchemaKindDeclaration {
  readonly retired?: boolean;
  readonly retiredAt?: string;
  readonly reason?: string;
  readonly id: string;
  readonly entityType: "schema";
  readonly schemaRef: string;
  readonly contractEntity: boolean;
}

export interface ArtifactEntityKindDefinition {
  readonly retired?: boolean;
  readonly retiredAt?: string;
  readonly reason?: string;
  /** Stable opaque identity. Minted once at creation; survives rename, schema publication and archive. */
  readonly kindId: string;
  /**
   * The canonical workspace revision this kind row was last accepted at, and therefore the fence a
   * caller writing this kind presents. Install seeds carry none; the declaring event stamps it.
   */
  readonly revision?: number;
  /** Qualified name used for selection and install de-duplication only; renaming it changes no ref. */
  readonly id: string;
  readonly entityType: "artifact";
  readonly schemaVersions: readonly EntityKindSchemaVersion[];
  readonly idPrefix: string;
  readonly display: { readonly singular: string; readonly plural: string };
  readonly descriptorSchemaRef: string;
  readonly store: { readonly pathTemplate: string };
  readonly locatorKinds: readonly ArtifactLocatorKind[];
  readonly relations?: readonly ArtifactRelationDefinition[];
  readonly maturityVocabulary?: readonly string[];
}

export type VerticalEntityKindDeclaration =
  | VerticalLifecycleKindDeclaration
  | VerticalSchemaKindDeclaration
  | ArtifactEntityKindDefinition;

export interface VerticalDefinition {
  readonly schema: "vertical-definition/v1";
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly entityFieldExtensions?: readonly VerticalEntityFieldExtension[];
  readonly entityKinds: readonly VerticalEntityKindDeclaration[];
  readonly contractEntityKinds: readonly string[];
  readonly packageScaffolds: readonly {
    readonly entityKind: string;
    readonly templateSelections: readonly VerticalTemplateSelection[];
  }[];
  readonly repositoryScaffold: VerticalRepositoryScaffold;
  readonly scripts: readonly VerticalScript[];
  readonly templateSelections: readonly VerticalTemplateSelection[];
  readonly checkerProfile: string;
  readonly projectionSchemas: readonly { readonly id: string; readonly schemaRef: string }[];
}

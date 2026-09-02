import { Schema } from "effect";
import { RelationTypeSchema } from "./entity-relations.ts";

const LocaleSchema = Schema.Literal("zh-CN", "en-US");
const StringArray = Schema.Array(Schema.String);
const NonBlankStringSchema = Schema.String.pipe(Schema.pattern(/\S/u));

const TemplateSelectionSchema = Schema.Struct({
  slot: Schema.String,
  templateRef: Schema.String,
  materializeAs: Schema.String,
  localePolicy: Schema.Struct({
    prefer: Schema.Literal("project", "preset", "explicit"),
    fallback: LocaleSchema,
  }),
  requiredWhen: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.String,
    }),
  ),
});

const RepositoryScaffoldCreateModeSchema = Schema.Literal("init", "lazy");

const RepositorySeededDocSchema = Schema.Struct({
  slot: Schema.String,
  templateRef: Schema.String,
  materializeAs: Schema.String,
  localePolicy: Schema.Struct({
    prefer: Schema.Literal("project", "preset", "explicit"),
    fallback: LocaleSchema,
  }),
  requiredWhen: Schema.optional(
    Schema.Record({
      key: Schema.String,
      value: Schema.String,
    }),
  ),
  overwrite: Schema.optional(Schema.Boolean),
});

// AGENTS.md three-layer composite slot (ADR-0021 D2/D5).
// L1 base (kernel invariants, deterministic) + L2 vertical overlay (house style,
// deterministic) are composed into a single AGENTS.md; L3 repo specifics are
// appended by the init Configure/Verify step under `repoSpecificsAnchor`, never
// rewriting L1/L2. Composition lives in the CLI materializer, not in the kernel
// 1:1 materialization contract.
const AgentsEntrySchema = Schema.Struct({
  materializeAs: Schema.String,
  localePolicy: Schema.Struct({
    prefer: Schema.Literal("project", "preset", "explicit"),
    fallback: LocaleSchema,
  }),
  baseRef: Schema.String,
  overlayRef: Schema.String,
  repoSpecificsAnchor: Schema.optional(Schema.String),
  overwrite: Schema.optional(Schema.Boolean),
});

const RepositoryScaffoldSchema = Schema.Struct({
  entityRoots: Schema.Array(
    Schema.Struct({
      entityKind: Schema.String,
      path: Schema.String,
      create: RepositoryScaffoldCreateModeSchema,
    }),
  ),
  dirs: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      create: RepositoryScaffoldCreateModeSchema,
    }),
  ),
  seededDocs: Schema.Array(RepositorySeededDocSchema),
  agentsEntry: Schema.optional(AgentsEntrySchema),
});

const VerticalScriptSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("script"),
  command: Schema.String,
  reads: StringArray,
  writes: StringArray,
  inputs: Schema.Record({
    key: Schema.String,
    value: Schema.String,
  }),
  metadata: Schema.Struct({
    description: Schema.String,
    purpose: Schema.Literal("scaffold", "generate", "transform", "audit"),
    kind: Schema.optional(Schema.Literal("action", "check")),
    contractVersion: Schema.Literal("script-entry/v1"),
    produces: StringArray,
  }),
});

const EntityFieldExtensionSchema = Schema.Struct({
  extends: Schema.Literal("task"),
  field: Schema.String,
  kind: Schema.Literal("enum-facet"),
  values: StringArray.pipe(Schema.minItems(1)),
  default: Schema.Literal(null),
  mutability: Schema.Literal("amendable"),
  projection: Schema.Struct({
    column: Schema.String,
    queryable: Schema.Boolean,
  }),
  reason: Schema.String,
});

export const artifactLocatorKinds = Object.freeze(["repository-path", "url", "external-key"] as const);

const ArtifactRelationSchema = Schema.Struct({
  type: RelationTypeSchema,
  sourceKind: NonBlankStringSchema,
  targetKind: NonBlankStringSchema,
  reads: NonBlankStringSchema,
  strength: Schema.Literal("weak", "strong"),
  rationale: Schema.optional(NonBlankStringSchema),
  decisionClaimRef: NonBlankStringSchema,
  decisionContentPin: Schema.String.pipe(Schema.pattern(/^sha256:[0-9a-f]{64}$/u)),
});

const ArtifactEntityKindSchema = Schema.Struct({
  id: Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u)),
  entityType: Schema.Literal("artifact"),
  version: Schema.Number.pipe(Schema.int(), Schema.greaterThan(0)),
  idPrefix: Schema.String.pipe(Schema.pattern(/^[A-Z][A-Z0-9]{0,15}$/u)),
  display: Schema.Struct({
    singular: NonBlankStringSchema,
    plural: NonBlankStringSchema,
  }),
  descriptorSchemaRef: Schema.String.pipe(Schema.pattern(/^schema:\/\/[A-Za-z0-9][A-Za-z0-9/_.@-]*$/u)),
  store: Schema.Struct({
    pathTemplate: NonBlankStringSchema,
  }),
  locatorKinds: Schema.Array(Schema.Literal(...artifactLocatorKinds)).pipe(Schema.minItems(1)),
  relations: Schema.optional(Schema.Array(ArtifactRelationSchema)),
  maturityVocabulary: Schema.optional(Schema.Array(NonBlankStringSchema).pipe(Schema.minItems(1))),
});

export const VerticalDefinitionSchema = Schema.Struct({
  schema: Schema.Literal("vertical-definition/v1"),
  id: Schema.String,
  title: Schema.String,
  version: Schema.String,
  entityFieldExtensions: Schema.optional(Schema.Array(EntityFieldExtensionSchema)),
  entityKinds: Schema.Array(
    Schema.Union(
      Schema.Struct({
        id: Schema.String,
        entityType: Schema.Literal("lifecycle"),
        packageKind: Schema.String,
        contractEntity: Schema.Boolean,
      }),
      Schema.Struct({
        id: Schema.String,
        entityType: Schema.Literal("schema"),
        schemaRef: Schema.String,
        contractEntity: Schema.Boolean,
      }),
      ArtifactEntityKindSchema,
    ),
  ).pipe(Schema.minItems(1)),
  contractEntityKinds: StringArray,
  packageScaffolds: Schema.Array(
    Schema.Struct({
      entityKind: Schema.String,
      templateSelections: Schema.Array(TemplateSelectionSchema),
    }),
  ),
  repositoryScaffold: RepositoryScaffoldSchema,
  scripts: Schema.Array(VerticalScriptSchema),
  templateSelections: Schema.Array(TemplateSelectionSchema),
  checkerProfile: Schema.String,
  projectionSchemas: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      schemaRef: Schema.String,
    }),
  ),
});

export type VerticalDefinition = Schema.Schema.Type<typeof VerticalDefinitionSchema>;
export type ArtifactEntityKindDefinition = Extract<
  VerticalDefinition["entityKinds"][number],
  { readonly entityType: "artifact" }
>;
export type ArtifactRelationDefinition = NonNullable<ArtifactEntityKindDefinition["relations"]>[number];

/** Decode once, fail closed on every unknown field, and preserve that exact value for compilation consumers. */
export function decodeVerticalDefinition(input: unknown): VerticalDefinition {
  return Schema.decodeUnknownSync(VerticalDefinitionSchema, { onExcessProperty: "error" })(input);
}

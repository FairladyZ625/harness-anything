import { Schema } from "effect";

const LocaleSchema = Schema.Literal("zh-CN", "en-US");
const StringArray = Schema.Array(Schema.String);

const TemplateSelectionSchema = Schema.Struct({
  slot: Schema.String,
  templateRef: Schema.String,
  materializeAs: Schema.String,
  localePolicy: Schema.Struct({
    prefer: Schema.Literal("project", "preset", "explicit"),
    fallback: LocaleSchema
  }),
  requiredWhen: Schema.optional(Schema.Record({
    key: Schema.String,
    value: Schema.String
  }))
});

const RepositoryScaffoldCreateModeSchema = Schema.Literal("init", "lazy");

const RepositorySeededDocSchema = Schema.Struct({
  slot: Schema.String,
  templateRef: Schema.String,
  materializeAs: Schema.String,
  localePolicy: Schema.Struct({
    prefer: Schema.Literal("project", "preset", "explicit"),
    fallback: LocaleSchema
  }),
  requiredWhen: Schema.optional(Schema.Record({
    key: Schema.String,
    value: Schema.String
  })),
  overwrite: Schema.optional(Schema.Boolean)
});

const RepositoryScaffoldSchema = Schema.Struct({
  entityRoots: Schema.Array(Schema.Struct({
    entityKind: Schema.String,
    path: Schema.String,
    create: RepositoryScaffoldCreateModeSchema
  })),
  dirs: Schema.Array(Schema.Struct({
    path: Schema.String,
    create: RepositoryScaffoldCreateModeSchema
  })),
  seededDocs: Schema.Array(RepositorySeededDocSchema)
});

const VerticalScriptSchema = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("script"),
  command: Schema.String,
  reads: StringArray,
  writes: StringArray,
  inputs: Schema.Record({
    key: Schema.String,
    value: Schema.String
  }),
  metadata: Schema.Struct({
    description: Schema.String,
    purpose: Schema.Literal("scaffold", "generate", "transform", "audit"),
    contractVersion: Schema.Literal("script-entry/v1"),
    produces: StringArray
  })
});

export const VerticalDefinitionSchema = Schema.Struct({
  schema: Schema.Literal("vertical-definition/v1"),
  id: Schema.String,
  title: Schema.String,
  version: Schema.String,
  entityKinds: Schema.Array(Schema.Union(
    Schema.Struct({
      id: Schema.String,
      entityType: Schema.Literal("lifecycle"),
      packageKind: Schema.String,
      contractEntity: Schema.Boolean
    }),
    Schema.Struct({
      id: Schema.String,
      entityType: Schema.Literal("schema"),
      schemaRef: Schema.String,
      contractEntity: Schema.Boolean
    })
  )).pipe(Schema.minItems(1)),
  contractEntityKinds: StringArray,
  packageScaffolds: Schema.Array(Schema.Struct({
    entityKind: Schema.String,
    templateSelections: Schema.Array(TemplateSelectionSchema)
  })),
  repositoryScaffold: RepositoryScaffoldSchema,
  scripts: Schema.Array(VerticalScriptSchema),
  templateSelections: Schema.Array(TemplateSelectionSchema),
  checkerProfile: Schema.String,
  projectionSchemas: Schema.Array(Schema.Struct({
    id: Schema.String,
    schemaRef: Schema.String
  }))
});

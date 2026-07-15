import { Schema } from "effect";

const StableKebabIdentifierSchema = Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u));
const PresetInputNameSchema = Schema.String.pipe(Schema.pattern(/^[A-Za-z][A-Za-z0-9_-]*$/u));
const NonEmptyStringSchema = Schema.String.pipe(Schema.minLength(1));
const LogicalSchemaIdSchema = Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9-]*\/v[1-9][0-9]*$/u));
const MediaTypeSchema = Schema.String.pipe(Schema.pattern(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u));
const Rfc3339TimestampSchema = Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u));
const ConfigIdentifierSchema = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9/_@.-]*$/u));

const StringInputSchema = Schema.Struct({
  type: Schema.Literal("string"), required: Schema.Boolean, default: Schema.optional(Schema.String)
});
const BooleanInputSchema = Schema.Struct({
  type: Schema.Literal("boolean"), required: Schema.Boolean, default: Schema.optional(Schema.Boolean)
});
const IntegerInputSchema = Schema.Struct({
  type: Schema.Literal("integer"), required: Schema.Boolean, default: Schema.optional(Schema.Number.pipe(Schema.int()))
});
const EnumInputSchema = Schema.Struct({
  type: Schema.Literal("enum"), required: Schema.Boolean,
  values: Schema.Array(NonEmptyStringSchema).pipe(Schema.minItems(1)), default: Schema.optional(Schema.String)
});
const EnumListInputSchema = Schema.Struct({
  type: Schema.Literal("enum-list"), required: Schema.Boolean,
  values: Schema.Array(NonEmptyStringSchema).pipe(Schema.minItems(1)), default: Schema.optional(Schema.Array(Schema.String))
});
const TaskRefInputSchema = Schema.Struct({
  type: Schema.Literal("task-ref"), required: Schema.Boolean,
  default: Schema.optional(NonEmptyStringSchema), defaultFrom: Schema.optional(Schema.Literal("current-task"))
}).pipe(Schema.filter((input) => input.default === undefined || input.defaultFrom === undefined));
const DecisionRefInputSchema = Schema.Struct({
  type: Schema.Literal("decision-ref"), required: Schema.Boolean,
  default: Schema.optional(NonEmptyStringSchema), defaultFrom: Schema.optional(Schema.Literal("current-decision"))
}).pipe(Schema.filter((input) => input.default === undefined || input.defaultFrom === undefined));
const PresetRefListInputSchema = Schema.Struct({
  type: Schema.Literal("preset-ref-list"), required: Schema.Boolean,
  default: Schema.optional(Schema.Array(NonEmptyStringSchema))
});
const ArtifactRefListInputSchema = Schema.Struct({
  type: Schema.Literal("artifact-ref-list"), required: Schema.Boolean,
  default: Schema.optional(Schema.Array(NonEmptyStringSchema))
});

export const PresetInputV3Schema = Schema.Union(
  StringInputSchema, BooleanInputSchema, IntegerInputSchema, EnumInputSchema, TaskRefInputSchema,
  DecisionRefInputSchema, PresetRefListInputSchema, ArtifactRefListInputSchema, EnumListInputSchema
);

const TasksRequirementSchema = Schema.Struct({
  capability: Schema.Literal("tasks"), version: Schema.Literal("1"),
  select: Schema.Union(
    Schema.Struct({ scope: Schema.Literal("all"), view: Schema.Literal("identity-and-preset") }),
    Schema.Struct({ taskFrom: PresetInputNameSchema, view: Schema.Literal("intent-summary") })
  )
});
const DecisionsRequirementSchema = Schema.Struct({
  capability: Schema.Literal("decisions"), version: Schema.Literal("1"),
  select: Schema.Union(
    Schema.Struct({ states: Schema.Array(Schema.Literal("active")).pipe(Schema.minItems(1)), view: Schema.Literal("canon-summary") }),
    Schema.Struct({ relatedToTaskFrom: PresetInputNameSchema, view: Schema.Literal("intent-summary") })
  )
});
const AdrsRequirementSchema = Schema.Struct({
  capability: Schema.Literal("adrs"), version: Schema.Literal("1"),
  select: Schema.Struct({
    states: Schema.Array(Schema.Literal("accepted", "active", "approved")).pipe(Schema.minItems(1)),
    view: Schema.Literal("canon-summary")
  })
});
const OperatingDocsRequirementSchema = Schema.Struct({
  capability: Schema.Literal("operating-docs"), version: Schema.Literal("1"),
  select: Schema.Struct({
    collections: Schema.Array(Schema.Literal("agents-guide", "governance", "standards")).pipe(Schema.minItems(1)),
    view: Schema.Literal("text")
  })
});
const TaskArtifactsRequirementSchema = Schema.Struct({
  capability: Schema.Literal("task-artifacts"), version: Schema.Literal("1"),
  select: Schema.Union(
    Schema.Struct({ scope: Schema.Literal("all-tasks"), artifactIds: Schema.Array(StableKebabIdentifierSchema).pipe(Schema.minItems(1)) }),
    Schema.Struct({ taskFrom: PresetInputNameSchema, artifactIds: Schema.Array(StableKebabIdentifierSchema).pipe(Schema.minItems(1)) })
  )
});
const RelationGraphRequirementSchema = Schema.Struct({
  capability: Schema.Literal("relation-graph"), version: Schema.Literal("1"),
  select: Schema.Struct({ scope: Schema.Literal("decision-or-all"), decisionFrom: PresetInputNameSchema, view: Schema.Literal("dossier") })
});
const RuntimeEventsRequirementSchema = Schema.Struct({
  capability: Schema.Literal("runtime-events"), version: Schema.Literal("1"),
  select: Schema.Struct({ view: Schema.Literal("command-usage") })
});
const GeneratedArtifactsRequirementSchema = Schema.Struct({
  capability: Schema.Literal("generated-artifacts"), version: Schema.Literal("1"),
  select: Schema.Struct({ view: Schema.Literal("presence-inventory"), familiesFrom: PresetInputNameSchema })
});
const WriteJournalRequirementSchema = Schema.Struct({
  capability: Schema.Literal("write-journal"), version: Schema.Literal("1"),
  select: Schema.Struct({ view: Schema.Literal("presence-inventory") })
});
const DocmapRequirementSchema = Schema.Struct({
  capability: Schema.Literal("docmap"), version: Schema.Literal("1"), select: Schema.Struct({ view: Schema.Literal("presence") })
});
const ExternalSourcePackRequirementSchema = Schema.Struct({
  capability: Schema.Literal("external-source-pack"), version: Schema.Literal("1"),
  select: Schema.Struct({ packFrom: PresetInputNameSchema, view: Schema.Literal("files-with-provenance") })
});
const RepositorySourceRequirementSchema = Schema.Struct({
  capability: Schema.Literal("repository-source"), version: Schema.Literal("1"),
  select: Schema.Struct({
    collections: Schema.Array(Schema.Literal("project-config", "gate-tooling", "product-source")).pipe(Schema.minItems(1)),
    view: Schema.Literal("text-snapshot")
  })
});

export const PresetCapabilityRequirementSchema = Schema.Union(
  TasksRequirementSchema, DecisionsRequirementSchema, AdrsRequirementSchema, OperatingDocsRequirementSchema,
  TaskArtifactsRequirementSchema, RelationGraphRequirementSchema, RuntimeEventsRequirementSchema,
  GeneratedArtifactsRequirementSchema, WriteJournalRequirementSchema, DocmapRequirementSchema,
  ExternalSourcePackRequirementSchema, RepositorySourceRequirementSchema
);

export const LogicalArtifactV1Schema = Schema.Struct({
  id: StableKebabIdentifierSchema, schema: LogicalSchemaIdSchema,
  mediaTypes: Schema.Array(MediaTypeSchema).pipe(Schema.minItems(1)),
  cardinality: Schema.Literal("one"), required: Schema.Boolean
});
const TaskArtifactsProductionSchema = Schema.Struct({
  capability: Schema.Literal("task-artifacts"), version: Schema.Literal("1"),
  target: Schema.Struct({ taskFrom: PresetInputNameSchema }),
  artifacts: Schema.Array(LogicalArtifactV1Schema).pipe(Schema.minItems(1))
});
const TaskDocumentsProductionSchema = Schema.Struct({
  capability: Schema.Literal("task-documents"), version: Schema.Literal("1"),
  target: Schema.Struct({ taskFrom: PresetInputNameSchema }),
  documents: Schema.Array(LogicalArtifactV1Schema).pipe(Schema.minItems(1))
});
export const PresetCapabilityProductionSchema = Schema.Union(TaskArtifactsProductionSchema, TaskDocumentsProductionSchema);

const RawFsScopePatternSchema = Schema.String.pipe(
  Schema.pattern(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)(?!.*\u0000)(?!\*\*$)[A-Za-z0-9._*?{}/!-]+$/u)
);
export const PresetRawFsEffectSchema = Schema.Struct({
  effect: Schema.Literal("raw-fs"), id: StableKebabIdentifierSchema,
  access: Schema.Literal("read", "staged-write"),
  scopes: Schema.Array(Schema.Struct({
    root: Schema.Literal("project", "authored", "local", "output"), pattern: RawFsScopePatternSchema
  })).pipe(Schema.minItems(1)),
  justification: NonEmptyStringSchema,
  approval: Schema.Struct({
    owner: ConfigIdentifierSchema,
    decisionRef: Schema.String.pipe(Schema.pattern(/^dec_[A-Za-z0-9]+$/u)),
    policyGrant: Schema.String.pipe(Schema.pattern(/^raw-fs\/[A-Za-z0-9][A-Za-z0-9._-]*$/u)),
    expiresAt: Rfc3339TimestampSchema
  })
});

export const presetCapabilityCatalog = [
  { id: "tasks", version: "1", directions: ["requires"], dataShape: "typed-task-projection/v1", authorityEnvelope: "read-only-selected-task-fields" },
  { id: "decisions", version: "1", directions: ["requires"], dataShape: "typed-decision-projection/v1", authorityEnvelope: "read-only-selected-decision-fields" },
  { id: "adrs", version: "1", directions: ["requires"], dataShape: "typed-adr-projection/v1", authorityEnvelope: "read-only-selected-adr-fields" },
  { id: "operating-docs", version: "1", directions: ["requires"], dataShape: "named-operating-docs/v1", authorityEnvelope: "read-only-named-collections" },
  { id: "task-artifacts", version: "1", directions: ["requires", "produces"], dataShape: "logical-task-artifacts/v1", authorityEnvelope: "selected-snapshot-or-staged-writer" },
  { id: "relation-graph", version: "1", directions: ["requires"], dataShape: "typed-relation-graph-view/v1", authorityEnvelope: "read-only-dossier-snapshot" },
  { id: "runtime-events", version: "1", directions: ["requires"], dataShape: "runtime-command-usage/v1", authorityEnvelope: "read-only-aggregated-events" },
  { id: "generated-artifacts", version: "1", directions: ["requires"], dataShape: "generated-artifact-inventory/v1", authorityEnvelope: "read-only-presence-inventory" },
  { id: "write-journal", version: "1", directions: ["requires"], dataShape: "write-journal-inventory/v1", authorityEnvelope: "read-only-presence-inventory" },
  { id: "docmap", version: "1", directions: ["requires"], dataShape: "docmap-presence/v1", authorityEnvelope: "read-only-presence" },
  { id: "task-documents", version: "1", directions: ["produces"], dataShape: "logical-task-documents/v1", authorityEnvelope: "staged-task-document-writer" },
  { id: "external-source-pack", version: "1", directions: ["requires"], dataShape: "provenance-source-pack/v1", authorityEnvelope: "read-only-approved-source-pack" },
  { id: "repository-source", version: "1", directions: ["requires"], dataShape: "repository-source-snapshot/v1", authorityEnvelope: "read-only-selected-repository-text" }
] as const;

const PresetIntentV3Schema = Schema.Struct({
  verb: Schema.Literal("audit", "check", "capture", "gather", "generate", "plan", "scaffold", "sync", "transform"),
  subject: StableKebabIdentifierSchema
});
const PresetEntrypointV3CommonFields = {
  intent: PresetIntentV3Schema,
  inputs: Schema.Record({ key: PresetInputNameSchema, value: PresetInputV3Schema }),
  requires: Schema.Array(PresetCapabilityRequirementSchema),
  produces: Schema.Array(PresetCapabilityProductionSchema),
  sideEffects: Schema.Array(PresetRawFsEffectSchema)
};
export const PresetEntrypointV3Schema = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("template"), templates: Schema.Record({ key: Schema.String, value: Schema.String }),
    ...PresetEntrypointV3CommonFields
  }),
  Schema.Struct({ type: Schema.Literal("script"), command: Schema.String, ...PresetEntrypointV3CommonFields })
);

export type PresetInputV3 = Schema.Schema.Type<typeof PresetInputV3Schema>;
export type PresetCapabilityRequirement = Schema.Schema.Type<typeof PresetCapabilityRequirementSchema>;
export type PresetCapabilityProduction = Schema.Schema.Type<typeof PresetCapabilityProductionSchema>;
export type LogicalArtifactV1 = Schema.Schema.Type<typeof LogicalArtifactV1Schema>;
export type PresetRawFsEffect = Schema.Schema.Type<typeof PresetRawFsEffectSchema>;
export type PresetEntrypointV3 = Schema.Schema.Type<typeof PresetEntrypointV3Schema>;

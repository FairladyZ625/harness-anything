import { Schema } from "effect";
import { domainStatuses } from "../domain/lifecycle-status.ts";
import { packageDispositions } from "../domain/package-disposition.ts";
import type { LifecycleBinding } from "../domain/lifecycle-binding.ts";

export const DomainStatusSchema = Schema.Literal(
  ...domainStatuses
);

export const SnapshotStatusSchema = Schema.Union(DomainStatusSchema, Schema.Literal("unknown"));
export const FreshnessSchema = Schema.Literal("fresh", "stale-but-usable", "unavailable-no-cache");
export const ActorKindSchema = Schema.Literal("agent", "human", "system");
export const LinkKindSchema = Schema.Literal("artifact", "commit", "review");

const OptionalString = Schema.optional(Schema.String);
const NullableString = Schema.NullOr(Schema.String);
const StringArray = Schema.Array(Schema.String);
const LocaleSchema = Schema.Literal("zh-CN", "en-US");
const LegacyRootSchema = Schema.Literal("harness/legacy");
const LegacyPathSchema = Schema.String.pipe(Schema.pattern(/^harness\/legacy\/(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\/\/)(?!.*\\).+$/u));
const LegacyConfidenceSchema = Schema.Literal("high", "medium", "low");
const StrictSha256Schema = Schema.String.pipe(Schema.pattern(/^sha256:[a-f0-9]{64}$/u));

export const ActorRefSchema = Schema.Struct({
  kind: ActorKindSchema,
  id: Schema.String
});

export const HarnessConfigSchema = Schema.Struct({
  schema: Schema.Literal("harness/v2"),
  project: Schema.Struct({
    id: Schema.String,
    locale: Schema.Literal("zh-CN", "en-US")
  }),
  lifecycle: Schema.Struct({
    default: Schema.String,
    enabled: StringArray,
    engines: Schema.Record({
      key: Schema.String,
      value: Schema.Struct({
        kind: Schema.String,
        workspace: OptionalString,
        project: OptionalString
      })
    })
  }),
  vertical: Schema.Struct({
    default: Schema.String
  }),
  presets: Schema.Struct({
    default: Schema.String
  }),
  storage: Schema.Struct({
    markdownRoot: Schema.String,
    sqlitePath: Schema.String,
    journalPath: Schema.String
  })
});

export const Sha256FingerprintSchema = Schema.TemplateLiteral("sha256:", Schema.String);

export const LifecycleBindingSchema = Schema.Struct({
  bindingSchema: Schema.Literal("lifecycle-binding/v1"),
  engine: Schema.String,
  status: Schema.optional(DomainStatusSchema),
  ref: NullableString,
  titleSnapshot: NullableString,
  url: NullableString,
  bindingCreatedAt: Schema.String,
  bindingFingerprint: Sha256FingerprintSchema
});

// Compile-time anchor: the schema's decoded type and the domain's
// LifecycleBinding must stay the same shape. Field drift fails tsc here,
// not in a runtime alignment test.
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
type LifecycleBindingDecoded = Schema.Schema.Type<typeof LifecycleBindingSchema>;
true satisfies MutuallyAssignable<LifecycleBindingDecoded, LifecycleBinding>;
true satisfies MutuallyAssignable<keyof LifecycleBindingDecoded, keyof LifecycleBinding>;

const CreatedBySchema = Schema.Struct({
  name: Schema.String,
  email: Schema.String
});

export const TaskFrontmatterSchema = Schema.Struct({
  schema: Schema.Literal("task-package/v2"),
  task_id: Schema.String,
  title: Schema.String,
  lifecycle: LifecycleBindingSchema,
  packageDisposition: Schema.Literal(...packageDispositions),
  vertical: Schema.String,
  preset: Schema.String,
  profile: Schema.optional(Schema.String),
  createdBy: Schema.optional(CreatedBySchema)
});

export const WriteJournalOpSchema = Schema.Struct({
  schema: Schema.Literal("write-journal/v1"),
  opId: Schema.String,
  taskId: Schema.String,
  kind: Schema.Literal("package_create", "transition_local", "progress_append", "doc_write", "package_archive", "package_tombstone", "package_reopen", "package_supersede", "package_delete_hard"),
  actor: ActorRefSchema,
  at: Schema.String,
  payloadRef: Schema.optional(Schema.Struct({
    path: Schema.String,
    sha256: Schema.String
  })),
  payload: Schema.optional(Schema.Record({
    key: Schema.String,
    value: Schema.Unknown
  }))
});

export const TaskSnapshotSchema = Schema.Struct({
  canonicalStatus: SnapshotStatusSchema,
  rawStatus: Schema.String,
  freshness: FreshnessSchema,
  fetchedAt: Schema.String,
  expiresAt: OptionalString,
  staleReason: OptionalString,
  source: Schema.Literal("local-document", "external-engine", "snapshot-cache"),
  engine: Schema.String,
  ref: OptionalString,
  assignee: OptionalString,
  parentRef: OptionalString,
  url: OptionalString,
  title: OptionalString
});

export const RedactionFindingSchema = Schema.Struct({
  ruleId: Schema.String,
  severity: Schema.Literal("info", "warning", "error"),
  message: Schema.String,
  path: OptionalString
});

const PublishableLinkSchema = Schema.Struct({
  label: Schema.String,
  href: Schema.String,
  kind: LinkKindSchema
});

export const PublishableProjectionSchema = Schema.Struct({
  visibility: Schema.Literal("public-safe"),
  sourceTaskId: Schema.String,
  title: Schema.String,
  summary: Schema.String,
  links: Schema.Array(PublishableLinkSchema),
  readiness: Schema.Struct({
    closeoutReadiness: Schema.Literal("passed"),
    reviewGate: Schema.Literal("passed"),
    ciGate: Schema.Literal("passed"),
    evidenceLinks: Schema.Array(PublishableLinkSchema).pipe(Schema.minItems(1))
  }),
  redactionReport: Schema.Struct({
    scannerVersion: Schema.String,
    findings: Schema.Array(RedactionFindingSchema),
    passed: Schema.Literal(true)
  }),
  idempotencyKey: Schema.String
});

export const TemplateCatalogSchema = Schema.Struct({
  schema: Schema.Literal("template-catalog/v1"),
  package: Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    version: Schema.String,
    owner: Schema.String,
    locales: Schema.Array(LocaleSchema).pipe(Schema.minItems(1))
  }),
  documents: Schema.Array(Schema.Struct({
    id: Schema.String,
    version: Schema.String,
    documentKind: Schema.String,
    slot: Schema.String,
    materializeAs: Schema.String,
    frontmatterSchema: Schema.String,
    requiredAnchors: StringArray,
    fallbackLocale: LocaleSchema,
    locales: Schema.Array(Schema.Struct({
      locale: LocaleSchema,
      anchors: StringArray,
      body: Schema.String
    })).pipe(Schema.minItems(1))
  }))
});

export const TemplateSelectionSchema = Schema.Struct({
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

export const PresetProfileSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  checkerProfile: Schema.String,
  templateSelections: Schema.Array(TemplateSelectionSchema),
  capabilityImports: Schema.optional(Schema.Array(Schema.Struct({
    id: Schema.String,
    version: Schema.String
  })))
});

export const PresetManifestSchema = Schema.Struct({
  schema: Schema.Literal("preset-manifest/v1"),
  id: Schema.String,
  title: Schema.String,
  vertical: Schema.String,
  version: Schema.String,
  extends: OptionalString,
  kernelVersionRange: Schema.Struct({
    min: Schema.String,
    maxExclusive: OptionalString
  }),
  capabilityImports: Schema.Array(Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("checker", "scaffold", "projection", "command", "template"),
    version: Schema.String,
    required: Schema.Boolean
  })),
  profiles: Schema.Array(PresetProfileSchema).pipe(Schema.minItems(1)),
  defaultProfile: Schema.String
});

export const VerticalDefinitionSchema = Schema.Struct({
  schema: Schema.Literal("vertical-definition/v1"),
  id: Schema.String,
  title: Schema.String,
  version: Schema.String,
  entityKinds: Schema.Array(Schema.Struct({
    id: Schema.String,
    packageKind: Schema.String,
    contractEntity: Schema.Boolean
  })).pipe(Schema.minItems(1)),
  contractEntityKinds: StringArray,
  packageScaffolds: Schema.Array(Schema.Struct({
    entityKind: Schema.String,
    templateSelections: Schema.Array(TemplateSelectionSchema)
  })),
  templateSelections: Schema.Array(TemplateSelectionSchema),
  checkerProfile: Schema.String,
  projectionSchemas: Schema.Array(Schema.Struct({
    id: Schema.String,
    schemaRef: Schema.String
  }))
});

export const LegacyEvidencePointerSchema = Schema.Struct({
  kind: Schema.Literal("progress", "review", "walkthrough", "commit", "pr", "artifact", "note"),
  path: LegacyPathSchema,
  label: OptionalString
});

export const LegacyIndexEntrySchema = Schema.Struct({
  id: Schema.String,
  category: Schema.Literal("task", "doc"),
  sourcePath: Schema.String,
  storedPath: LegacyPathSchema,
  sourceDigest: StrictSha256Schema,
  title: OptionalString,
  detectedStatus: Schema.optional(Schema.Struct({
    raw: Schema.String,
    confidence: LegacyConfidenceSchema
  })),
  evidencePointers: Schema.Array(LegacyEvidencePointerSchema),
  recommendedTreatment: Schema.Literal("preserve", "rebuild-required", "supersede", "archive", "ignore"),
  humanReviewRequired: Schema.Boolean
});

export const LegacyIndexSchema = Schema.Struct({
  schema: Schema.Literal("legacy-index/v1"),
  legacyRoot: LegacyRootSchema,
  generatedAt: Schema.String,
  sourceRoot: Schema.String,
  entries: Schema.Array(LegacyIndexEntrySchema),
  summary: Schema.Struct({
    entryCount: Schema.Number,
    taskCount: Schema.Number,
    docCount: Schema.Number,
    rebuildRequiredCount: Schema.Number
  })
});

const LegacyCollisionEntrySchema = Schema.Struct({
  kind: Schema.Literal("file", "directory"),
  sourcePath: Schema.String,
  targetPath: Schema.String,
  chosenPath: LegacyPathSchema,
  suffixIndex: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
  reason: Schema.Literal("target-exists")
}).pipe(Schema.filter((entry) => {
  if (entry.targetPath === entry.chosenPath) return false;
  const escapedIndex = String(entry.suffixIndex).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  if (entry.kind === "directory") return new RegExp(`-legacy-import-${escapedIndex}$`, "u").test(entry.chosenPath);
  return new RegExp(`\\.legacy-import-${escapedIndex}(?:\\.[^/]+)?$`, "u").test(entry.chosenPath);
}));

export const LegacyCollisionReportSchema = Schema.Struct({
  schema: Schema.Literal("legacy-collision-report/v1"),
  legacyRoot: LegacyRootSchema,
  generatedAt: Schema.String,
  policy: Schema.Struct({
    overwriteAllowed: Schema.Literal(false),
    directorySuffixPattern: Schema.Literal("-legacy-import-N"),
    fileSuffixPattern: Schema.Literal(".legacy-import-N")
  }),
  entries: Schema.Array(LegacyCollisionEntrySchema)
});

export const SqliteTaskRowSchema = Schema.Struct({
  schema: Schema.Literal("sqlite-task-row/v1"),
  taskId: Schema.String,
  title: Schema.String,
  canonicalStatus: SnapshotStatusSchema,
  coordinationStatus: Schema.Literal("open", "blocked", "in_review", "terminal", "unknown"),
  rawStatus: Schema.String,
  packageDisposition: Schema.Literal(...packageDispositions),
  closeoutReadiness: Schema.Literal("not_required", "missing", "incomplete", "ready", "passed", "failed"),
  lifecycleEngine: Schema.String,
  freshness: FreshnessSchema,
  updatedAt: Schema.String,
  source: Schema.Literal("local-document", "external-engine", "snapshot-cache"),
  sourcePath: Schema.String,
  createdBy: Schema.optional(CreatedBySchema)
});

export const ProjectionWarningSourceSchema = Schema.Literal("source-package", "generated-cache", "collaboration-gate");
export const ProjectionWarningCodeSchema = Schema.Literal(
  "projection_missing",
  "projection_stale",
  "projection_tampered",
  "source_malformed",
  "duplicate_task_id",
  "duplicate_external_binding",
  "generated_tracked",
  "binding_tampered",
  "conflict_marker_present",
  "dangling_entity_ref",
  "relation_cycle_detected"
);

const HarnessCheckAxisReportSchema = Schema.Struct({
  axis: ProjectionWarningSourceSchema,
  ok: Schema.Boolean,
  warningCount: Schema.Number,
  hardFailCount: Schema.Number,
  codes: Schema.Array(ProjectionWarningCodeSchema)
});

export const HarnessCheckReportSchema = Schema.Struct({
  schema: Schema.Literal("harness-check-report/v1"),
  ok: Schema.Boolean,
  axes: Schema.Tuple(HarnessCheckAxisReportSchema, HarnessCheckAxisReportSchema, HarnessCheckAxisReportSchema),
  summary: Schema.Struct({
    rowCount: Schema.Number,
    warningCount: Schema.Number,
    hardFailCount: Schema.Number
  })
});

export const DocsReleasePromotionBundleSchema = Schema.Struct({
  schema: Schema.Literal("docs-release-promotion-bundle/v1"),
  projectionVersion: Schema.String,
  sourceTaskId: Schema.String,
  generatedAt: Schema.String,
  publicFiles: Schema.Array(Schema.Struct({
    path: Schema.String,
    sha256: Schema.String,
    kind: Schema.Literal("guide", "reference", "walkthrough", "release-note")
  })),
  redactionReport: PublishableProjectionSchema.fields.redactionReport
});

export type HarnessConfig = Schema.Schema.Type<typeof HarnessConfigSchema>;
export type TaskFrontmatter = Schema.Schema.Type<typeof TaskFrontmatterSchema>;
export type WriteJournalOp = Schema.Schema.Type<typeof WriteJournalOpSchema>;
export type TaskSnapshot = Schema.Schema.Type<typeof TaskSnapshotSchema>;
export type PublishableProjection = Schema.Schema.Type<typeof PublishableProjectionSchema>;
export type TemplateCatalog = Schema.Schema.Type<typeof TemplateCatalogSchema>;
export type TemplateSelection = Schema.Schema.Type<typeof TemplateSelectionSchema>;
export type PresetManifest = Schema.Schema.Type<typeof PresetManifestSchema>;
export type PresetProfile = Schema.Schema.Type<typeof PresetProfileSchema>;
export type VerticalDefinition = Schema.Schema.Type<typeof VerticalDefinitionSchema>;
export type LegacyEvidencePointer = Schema.Schema.Type<typeof LegacyEvidencePointerSchema>;
export type LegacyIndexEntry = Schema.Schema.Type<typeof LegacyIndexEntrySchema>;
export type LegacyIndex = Schema.Schema.Type<typeof LegacyIndexSchema>;
export type LegacyCollisionReport = Schema.Schema.Type<typeof LegacyCollisionReportSchema>;
export type SqliteTaskRow = Schema.Schema.Type<typeof SqliteTaskRowSchema>;
export type HarnessCheckReport = Schema.Schema.Type<typeof HarnessCheckReportSchema>;
export type DocsReleasePromotionBundle = Schema.Schema.Type<typeof DocsReleasePromotionBundleSchema>;

export const schemaRegistry = [
  {
    id: "harness-config",
    schema: HarnessConfigSchema,
    jsonSchemaPath: "packages/kernel/schemas/json/harness-config.schema.json",
    validFixturePath: "packages/kernel/fixtures/schemas/harness-config/valid.json",
    invalidFixturePath: "packages/kernel/fixtures/schemas/harness-config/invalid.json"
  },
  {
    id: "task-frontmatter",
    schema: TaskFrontmatterSchema,
    jsonSchemaPath: "packages/kernel/schemas/json/task-frontmatter.schema.json",
    validFixturePath: "packages/kernel/fixtures/schemas/task-frontmatter/valid.json",
    invalidFixturePath: "packages/kernel/fixtures/schemas/task-frontmatter/invalid.json"
  },
  {
    id: "write-journal-op",
    schema: WriteJournalOpSchema,
    jsonSchemaPath: "packages/kernel/schemas/json/write-journal-op.schema.json",
    validFixturePath: "packages/kernel/fixtures/schemas/write-journal-op/valid.json",
    invalidFixturePath: "packages/kernel/fixtures/schemas/write-journal-op/invalid.json"
  },
  {
    id: "task-snapshot",
    schema: TaskSnapshotSchema,
    jsonSchemaPath: "packages/kernel/schemas/json/task-snapshot.schema.json",
    validFixturePath: "packages/kernel/fixtures/schemas/task-snapshot/valid.json",
    invalidFixturePath: "packages/kernel/fixtures/schemas/task-snapshot/invalid.json"
  },
  {
    id: "publishable-projection",
    schema: PublishableProjectionSchema,
    jsonSchemaPath: "packages/kernel/schemas/json/publishable-projection.schema.json",
    validFixturePath: "packages/kernel/fixtures/schemas/publishable-projection/valid.json",
    invalidFixturePath: "packages/kernel/fixtures/schemas/publishable-projection/invalid.json"
  },
  {
    id: "template-catalog",
    schema: TemplateCatalogSchema,
    jsonSchemaPath: "packages/kernel/schemas/json/template-catalog.schema.json",
    validFixturePath: "packages/kernel/fixtures/schemas/template-catalog/valid.json",
    invalidFixturePath: "packages/kernel/fixtures/schemas/template-catalog/invalid.json"
  },
  {
    id: "preset-manifest",
    schema: PresetManifestSchema,
    jsonSchemaPath: "packages/kernel/schemas/json/preset-manifest.schema.json",
    validFixturePath: "packages/kernel/fixtures/schemas/preset-manifest/valid.json",
    invalidFixturePath: "packages/kernel/fixtures/schemas/preset-manifest/invalid.json"
  },
  {
    id: "vertical-definition",
    schema: VerticalDefinitionSchema,
    jsonSchemaPath: "packages/kernel/schemas/json/vertical-definition.schema.json",
    validFixturePath: "packages/kernel/fixtures/schemas/vertical-definition/valid.json",
    invalidFixturePath: "packages/kernel/fixtures/schemas/vertical-definition/invalid.json"
  },
  {
    id: "legacy-index",
    schema: LegacyIndexSchema,
    jsonSchemaPath: "packages/kernel/schemas/json/legacy-index.schema.json",
    validFixturePath: "packages/kernel/fixtures/schemas/legacy-index/valid.json",
    invalidFixturePath: "packages/kernel/fixtures/schemas/legacy-index/invalid.json"
  },
  {
    id: "legacy-collision-report",
    schema: LegacyCollisionReportSchema,
    jsonSchemaPath: "packages/kernel/schemas/json/legacy-collision-report.schema.json",
    validFixturePath: "packages/kernel/fixtures/schemas/legacy-collision-report/valid.json",
    invalidFixturePath: "packages/kernel/fixtures/schemas/legacy-collision-report/invalid.json"
  },
  {
    id: "sqlite-task-row",
    schema: SqliteTaskRowSchema,
    jsonSchemaPath: "packages/kernel/schemas/json/sqlite-task-row.schema.json",
    validFixturePath: "packages/kernel/fixtures/schemas/sqlite-task-row/valid.json",
    invalidFixturePath: "packages/kernel/fixtures/schemas/sqlite-task-row/invalid.json"
  },
  {
    id: "harness-check-report",
    schema: HarnessCheckReportSchema,
    jsonSchemaPath: "packages/kernel/schemas/json/harness-check-report.schema.json",
    validFixturePath: "packages/kernel/fixtures/schemas/harness-check-report/valid.json",
    invalidFixturePath: "packages/kernel/fixtures/schemas/harness-check-report/invalid.json"
  },
  {
    id: "docs-release-promotion-bundle",
    schema: DocsReleasePromotionBundleSchema,
    jsonSchemaPath: "packages/kernel/schemas/json/docs-release-promotion-bundle.schema.json",
    validFixturePath: "packages/kernel/fixtures/schemas/docs-release-promotion-bundle/valid.json",
    invalidFixturePath: "packages/kernel/fixtures/schemas/docs-release-promotion-bundle/invalid.json"
  }
] as const;

export const requiredSchemaIds = schemaRegistry.map((entry) => entry.id);

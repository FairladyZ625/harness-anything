import { Schema } from "effect";
import { domainStatuses } from "../domain/lifecycle-status.ts";
import { packageDispositions } from "../domain/package-disposition.ts";

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

export const LifecycleBindingSchema = Schema.Struct({
  bindingSchema: Schema.Literal("lifecycle-binding/v1"),
  engine: Schema.String,
  status: Schema.optional(DomainStatusSchema),
  ref: NullableString,
  titleSnapshot: NullableString,
  url: NullableString,
  bindingCreatedAt: Schema.String,
  bindingFingerprint: Schema.String
});

export const TaskFrontmatterSchema = Schema.Struct({
  schema: Schema.Literal("task-package/v2"),
  task_id: Schema.String,
  title: Schema.String,
  lifecycle: LifecycleBindingSchema,
  packageDisposition: Schema.Literal(...packageDispositions),
  vertical: Schema.String,
  preset: Schema.String
});

export const WriteJournalOpSchema = Schema.Struct({
  schema: Schema.Literal("write-journal/v1"),
  opId: Schema.String,
  taskId: Schema.String,
  kind: Schema.Literal("package_create", "transition_local", "progress_append", "doc_write", "package_archive"),
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

export const PublishableProjectionSchema = Schema.Struct({
  visibility: Schema.Literal("public-safe"),
  title: Schema.String,
  summary: Schema.String,
  links: Schema.Array(Schema.Struct({
    label: Schema.String,
    href: Schema.String,
    kind: LinkKindSchema
  })),
  redactionReport: Schema.Struct({
    scannerVersion: Schema.String,
    findings: Schema.Array(RedactionFindingSchema),
    passed: Schema.Literal(true)
  }),
  idempotencyKey: Schema.String
});

export const TemplateCatalogSchema = Schema.Struct({
  schema: Schema.Literal("template-catalog/v1"),
  templates: Schema.Array(Schema.Struct({
    id: Schema.String,
    documentKind: Schema.String,
    locale: Schema.Literal("zh-CN", "en-US"),
    slots: StringArray,
    frontmatterSchema: Schema.String
  }))
});

export const PresetManifestSchema = Schema.Struct({
  schema: Schema.Literal("preset-manifest/v1"),
  id: Schema.String,
  title: Schema.String,
  vertical: Schema.String,
  capabilities: Schema.Array(Schema.Struct({
    id: Schema.String,
    kind: Schema.Literal("checker", "scaffold", "projection", "command"),
    enabledByDefault: Schema.Boolean
  })),
  templates: StringArray
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
  sourcePath: Schema.String
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
export type PresetManifest = Schema.Schema.Type<typeof PresetManifestSchema>;
export type SqliteTaskRow = Schema.Schema.Type<typeof SqliteTaskRowSchema>;
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
    id: "sqlite-task-row",
    schema: SqliteTaskRowSchema,
    jsonSchemaPath: "packages/kernel/schemas/json/sqlite-task-row.schema.json",
    validFixturePath: "packages/kernel/fixtures/schemas/sqlite-task-row/valid.json",
    invalidFixturePath: "packages/kernel/fixtures/schemas/sqlite-task-row/invalid.json"
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

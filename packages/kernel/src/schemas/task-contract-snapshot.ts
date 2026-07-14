import { Schema } from "effect";

const Sha256DigestSchema = Schema.String.pipe(Schema.pattern(/^sha256:[a-f0-9]{64}$/u));
const IdentifierSchema = Schema.String.pipe(Schema.minLength(1));
const CompletionGateIdSchema = Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u));

export const TaskContractSnapshotSchema = Schema.Struct({
  schema: Schema.Literal("task-contract-snapshot/v1"),
  capturedAt: Schema.String,
  capturedBy: Schema.Literal("task-create", "legacy-migration", "explicit-upgrade"),
  vertical: IdentifierSchema,
  preset: Schema.Struct({
    id: IdentifierSchema,
    version: IdentifierSchema,
    digest: Sha256DigestSchema
  }),
  profile: Schema.Struct({
    id: IdentifierSchema,
    checkerProfile: IdentifierSchema,
    completionGates: Schema.Array(CompletionGateIdSchema)
  }),
  templateCatalog: Schema.Struct({
    id: IdentifierSchema,
    version: IdentifierSchema,
    digest: Sha256DigestSchema
  }),
  documents: Schema.Array(Schema.Struct({
    slot: IdentifierSchema,
    templateRef: IdentifierSchema,
    materializeAs: IdentifierSchema,
    locale: Schema.Literal("zh-CN", "en-US"),
    requiredAnchors: Schema.Array(Schema.String),
    bodyDigest: Sha256DigestSchema
  }))
});

export type TaskContractSnapshot = Schema.Schema.Type<typeof TaskContractSnapshotSchema>;

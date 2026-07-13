import { Schema } from "effect";
import { writeOpKinds } from "../domain/write-op-kind.ts";
import { ActorRefSchema } from "./common.ts";
import {
  ActorAxesSchema,
  ExecutorSourceSchema,
  PrincipalSourceSchema
} from "./actor-attribution.ts";

const EntityIdSchema = Schema.Union(
  Schema.TemplateLiteral("task/", Schema.String),
  Schema.TemplateLiteral("decision/", Schema.String),
  Schema.TemplateLiteral("module/", Schema.String),
  Schema.TemplateLiteral("entity/", Schema.String, "/", Schema.String)
);

export const WriteJournalOpKindSchema = Schema.Literal(...writeOpKinds);

export const JournalPayloadRefSchema = Schema.Struct({
  path: Schema.String,
  sha256: Schema.String
});

export const AuthorityOperationIntegritySchema = Schema.Struct({
  schema: Schema.Literal("authority-operation-integrity/v2"),
  semanticRequestDigest: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u)),
  semanticMutationSetDigest: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u)),
  mutationRegistryVersion: Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThanOrEqualTo(0),
    Schema.lessThanOrEqualTo(0xffff_ffff)
  ),
  actorAxesBindingDigest: Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u)),
  canonicalMutationSet: Schema.Struct({
    registryVersion: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0), Schema.lessThanOrEqualTo(0xffff_ffff)),
    mutations: Schema.Array(Schema.Struct({
      entity: Schema.Struct({
        registryVersion: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0), Schema.lessThanOrEqualTo(0xffff_ffff)),
        entityKind: Schema.String.pipe(Schema.pattern(/\S/u)),
        canonicalRef: Schema.String.pipe(Schema.pattern(/\S/u))
      }),
      action: Schema.Struct({
        registryVersion: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0), Schema.lessThanOrEqualTo(0xffff_ffff)),
        action: Schema.String.pipe(Schema.pattern(/\S/u))
      })
    }))
  })
});

const JournalPayloadSummarySchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown
});

const JournalRecordFields = {
  opId: Schema.String,
  entityId: EntityIdSchema,
  kind: WriteJournalOpKindSchema,
  at: Schema.String,
  payloadRef: Schema.optional(JournalPayloadRefSchema),
  payload: Schema.optional(JournalPayloadSummarySchema),
  authorityIntegrity: Schema.optional(AuthorityOperationIntegritySchema)
} as const;

export const JournalRecordV1Schema = Schema.Struct({
  schema: Schema.Literal("write-journal/v1"),
  ...JournalRecordFields,
  actor: ActorRefSchema
});

export const JournalRecordV2Schema = Schema.Struct({
  schema: Schema.Literal("write-journal/v2"),
  ...JournalRecordFields,
  actor: ActorAxesSchema,
  principalSource: PrincipalSourceSchema,
  executorSource: ExecutorSourceSchema
}).pipe(Schema.filter((record) => (
  record.actor.executor === null
    ? record.executorSource === "none"
    : record.executorSource === "client-asserted"
)));

export const ReadableJournalRecordSchema = Schema.Union(
  JournalRecordV1Schema,
  JournalRecordV2Schema
);

// The governed publication contract describes new writes. V1 remains a
// separate decoder branch for recovery compatibility and is never widened.
export const WriteJournalOpSchema = JournalRecordV2Schema;

export type JournalRecordV1Document = Schema.Schema.Type<typeof JournalRecordV1Schema>;
export type JournalRecordV2Document = Schema.Schema.Type<typeof JournalRecordV2Schema>;
export type ReadableJournalRecordDocument = Schema.Schema.Type<typeof ReadableJournalRecordSchema>;
export type WriteJournalOp = Schema.Schema.Type<typeof WriteJournalOpSchema>;

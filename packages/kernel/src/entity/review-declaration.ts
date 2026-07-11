import { Schema } from "effect";
import { reviewVerdicts } from "../domain/review.ts";
import { decodeEntityDeclaration, jsonEntityDocumentCodec } from "./declaration.ts";

const ReviewerActorSchema = Schema.Struct({
  principal: Schema.Struct({
    personId: Schema.String,
    displayName: Schema.optional(Schema.String),
    primaryEmail: Schema.optional(Schema.String),
    providerId: Schema.optional(Schema.String),
    credential: Schema.optional(Schema.Struct({ kind: Schema.String, issuer: Schema.String, subject: Schema.String }))
  }),
  executor: Schema.NullOr(Schema.Struct({ kind: Schema.Literal("agent"), id: Schema.String })),
  responsibleHuman: Schema.String
});

export const ReviewSchema = Schema.Struct({
  schema: Schema.Literal("review/v2"),
  review_id: Schema.String.pipe(Schema.pattern(/^rev_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u)),
  task_ref: Schema.String.pipe(Schema.pattern(/^task\/task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u)),
  execution_ref: Schema.String.pipe(Schema.pattern(/^execution\/task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}\/exe_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u)),
  reviewer_actor: ReviewerActorSchema,
  reviewer_session_ref: Schema.String.pipe(Schema.pattern(/^session\/.+$/u)),
  findings: Schema.String.pipe(Schema.minLength(1)),
  evidence_checked: Schema.Array(Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u))),
  rationale: Schema.String.pipe(Schema.minLength(1)),
  verdict: Schema.Literal(...reviewVerdicts),
  archive_warnings_acknowledged: Schema.Boolean,
  reviewed_at: Schema.String
});

const ReviewV1Schema = Schema.Struct({
  schema: Schema.Literal("review/v1"),
  review_id: Schema.String,
  task_ref: Schema.String,
  execution_ref: Schema.String,
  reviewer_actor: ReviewerActorSchema,
  reviewer_session_ref: Schema.String,
  findings: Schema.String.pipe(Schema.minLength(1)),
  verdict: Schema.Literal(...reviewVerdicts),
  archive_warnings_acknowledged: Schema.Boolean,
  reviewed_at: Schema.String
});

const reviewDocumentCodec = {
  decode: (body: string): unknown => {
    const raw = jsonEntityDocumentCodec.decode(body) as { readonly schema?: unknown };
    if (raw.schema !== "review/v1") return raw;
    const legacy = Schema.decodeUnknownSync(ReviewV1Schema)(raw);
    return { ...legacy, schema: "review/v2", evidence_checked: [], rationale: legacy.findings };
  },
  encode: jsonEntityDocumentCodec.encode
};

export const reviewDeclaration = decodeEntityDeclaration({
  kind: "review",
  schema: ReviewSchema,
  documentCodec: reviewDocumentCodec,
  mutabilityContract: {
    identity: { mutability: "immutable", read: [{ kind: "show", path: "review.identity" }], write: [], reason: "review round identity is immutable" },
    verdict: { mutability: "immutable", read: [{ kind: "projection", path: "verdict", queryable: true }], write: [], reason: "a changed verdict requires a new review round" },
    findings: { mutability: "immutable", read: [{ kind: "show", path: "review.findings" }], write: [], reason: "review findings are durable history" }
  },
  anchors: { entityRef: "review/{taskId}/{reviewId}", anchors: [] },
  dispositionMatrix: {
    entries: {
      retire: { level: "D1", action: "retire", supported: false, writeOpKinds: [], reason: "dismissed is an explicit verdict" },
      supersede: { level: "D1", action: "supersede", supported: false, writeOpKinds: [], reason: "a new review is a new round" },
      invalidate: { level: "D1", action: "invalidate", supported: false, writeOpKinds: [], reason: "dismissed is an explicit verdict" },
      archive: { level: "D2", action: "archive", supported: false, writeOpKinds: [], reason: "review follows its host task" },
      tombstone: { level: "D3", action: "tombstone", supported: false, writeOpKinds: [], reason: "review history is durable" },
      "hard-delete": { level: "D4", action: "hard-delete", supported: false, writeOpKinds: [], reason: "review history is durable" }
    }
  },
  storageForm: "hosted-entity",
  rootResolver: {
    pathTemplate: "tasks/{taskId}/reviews/{reviewId}.md",
    identity: ["taskId", "reviewId"],
    host: { entityKind: "task", pathTemplate: "tasks/{taskId}", identity: ["taskId"] }
  },
  projection: {
    table: "review_projection",
    columns: [
      { name: "review_id", field: "review_id", type: "text", primaryKey: true },
      { name: "task_ref", field: "task_ref", type: "text" },
      { name: "execution_ref", field: "execution_ref", type: "text" },
      { name: "verdict", field: "verdict", type: "text" },
      { name: "reviewer_actor", field: "reviewer_actor", type: "json" },
      { name: "reviewer_session_ref", field: "reviewer_session_ref", type: "text" },
      { name: "findings", field: "findings", type: "text" },
      { name: "evidence_checked_json", field: "evidence_checked", type: "json" },
      { name: "rationale", field: "rationale", type: "text" },
      { name: "archive_warnings_acknowledged", field: "archive_warnings_acknowledged", type: "boolean" },
      { name: "reviewed_at", field: "reviewed_at", type: "text" }
    ]
  }
});

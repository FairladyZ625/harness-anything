import { Schema } from "effect";
import { executionStates } from "../domain/execution.ts";
import { decodeEntityDeclaration, jsonEntityDocumentCodec } from "./declaration.ts";

const PersonPrincipalSchema = Schema.Struct({
  personId: Schema.String,
  displayName: Schema.optional(Schema.String),
  primaryEmail: Schema.optional(Schema.String),
  providerId: Schema.optional(Schema.String),
  credential: Schema.optional(Schema.Struct({ kind: Schema.String, issuer: Schema.String, subject: Schema.String }))
});

const Sha256Schema = Schema.String.pipe(Schema.pattern(/^[0-9a-f]{64}$/u));
const StableIdSchema = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u));
const CurrentSessionRefSchema = Schema.Struct({
  runtime: Schema.String,
  sessionId: Schema.String,
  source: Schema.String,
  detectedAt: Schema.String,
  user: Schema.optional(Schema.String)
});
const CaptureRangeSchema = Schema.Struct({
  range_id: StableIdSchema,
  coordinate: Schema.Literal("timestamp"),
  start_at: Schema.String,
  end_at: Schema.NullOr(Schema.String),
  bounds: Schema.Literal("inclusive")
});
const SessionBindingSchema = Schema.Struct({
  binding_id: StableIdSchema,
  session_ref: Schema.NullOr(Schema.String),
  role: Schema.Literal("primary", "subagent", "reviewer_observer"),
  archive_status: Schema.Literal("pending", "complete", "partial", "unavailable"),
  attached_at: Schema.String,
  session: Schema.NullOr(CurrentSessionRefSchema),
  capture_range: Schema.NullOr(CaptureRangeSchema)
});
const CheckerReceiptSchema = Schema.Struct({
  checker_id: Schema.String.pipe(Schema.minLength(1)),
  checker_version: Schema.String.pipe(Schema.minLength(1)),
  target_evidence_id: StableIdSchema,
  target_sha256: Schema.NullOr(Sha256Schema),
  checked_at: Schema.String,
  result: Schema.Literal("pass", "fail")
});
const EvidenceLocatorSchema = Schema.Union(
  Schema.Struct({ substrate: Schema.Literal("inline"), text: Schema.String.pipe(Schema.minLength(1)) }),
  Schema.Struct({ substrate: Schema.Literal("file"), path: Schema.String.pipe(Schema.minLength(1)) }),
  Schema.Struct({ substrate: Schema.Literal("url"), url: Schema.String.pipe(Schema.minLength(1)) }),
  Schema.Struct({ substrate: Schema.Literal("object"), ref: Schema.String, sha256: Sha256Schema, size: Schema.Int.pipe(Schema.nonNegative()), media_type: Schema.String.pipe(Schema.minLength(1)) }),
  Schema.Struct({ substrate: Schema.Literal("entity"), entity_ref: Schema.String.pipe(Schema.minLength(1)) }),
  Schema.Struct({ substrate: Schema.Literal("checker_receipt"), receipt: CheckerReceiptSchema })
);
export const OutputEvidenceSchema = Schema.Struct({
  evidence_id: StableIdSchema,
  execution_ref: Schema.String.pipe(Schema.pattern(/^execution\/task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}\/exe_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u)),
  locator: EvidenceLocatorSchema,
  sha256: Schema.optional(Sha256Schema),
  checker_receipt_ref: Schema.optional(StableIdSchema)
});
const SubmissionPacketSchema = Schema.Struct({
  completion_claim: Schema.String.pipe(Schema.minLength(1)),
  deliverables: Schema.Array(Schema.String),
  evidence_refs: Schema.Array(StableIdSchema),
  verification_notes: Schema.Array(Schema.String),
  known_gaps: Schema.Array(Schema.String),
  residual_risks: Schema.Array(Schema.String)
});

export const ExecutionSchema = Schema.Struct({
  schema: Schema.Literal("execution/v2"),
  execution_id: Schema.String.pipe(Schema.pattern(/^exe_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u)),
  task_ref: Schema.String.pipe(Schema.pattern(/^task\/task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u)),
  state: Schema.Literal(...executionStates),
  primary_actor: Schema.Struct({
    principal: PersonPrincipalSchema,
    executor: Schema.NullOr(Schema.Struct({ kind: Schema.Literal("agent"), id: Schema.String })),
    responsibleHuman: Schema.String
  }),
  claimed_at: Schema.String,
  submitted_at: Schema.NullOr(Schema.String),
  closed_at: Schema.NullOr(Schema.String),
  session_bindings: Schema.Array(SessionBindingSchema),
  outputs: Schema.Array(OutputEvidenceSchema),
  submission: Schema.NullOr(SubmissionPacketSchema)
});

const ExecutionV1Schema = Schema.Struct({
  schema: Schema.Literal("execution/v1"),
  execution_id: Schema.String,
  task_ref: Schema.String,
  state: Schema.Literal(...executionStates),
  primary_actor: Schema.Struct({
    principal: PersonPrincipalSchema,
    executor: Schema.NullOr(Schema.Struct({ kind: Schema.Literal("agent"), id: Schema.String })),
    responsibleHuman: Schema.String
  }),
  claimed_at: Schema.String,
  submitted_at: Schema.NullOr(Schema.String),
  closed_at: Schema.NullOr(Schema.String),
  session_bindings: Schema.Array(Schema.Unknown),
  outputs: Schema.Array(Schema.Unknown),
  submission: Schema.NullOr(Schema.Struct({ summary: Schema.String, verification: Schema.Array(Schema.String), residual_risks: Schema.Array(Schema.String) }))
});

const executionDocumentCodec = {
  decode: (body: string): unknown => {
    const raw = jsonEntityDocumentCodec.decode(body) as { readonly schema?: unknown };
    if (raw.schema !== "execution/v1") return raw;
    const legacy = Schema.decodeUnknownSync(ExecutionV1Schema)(raw);
    return {
      ...legacy,
      schema: "execution/v2",
      session_bindings: legacy.session_bindings.map((binding, index) => upgradeLegacyBinding(binding, index, legacy.claimed_at)),
      outputs: [],
      submission: legacy.submission === null ? null : {
        completion_claim: legacy.submission.summary,
        deliverables: legacy.outputs.map((output) => JSON.stringify(output)),
        evidence_refs: [],
        verification_notes: legacy.submission.verification,
        known_gaps: [],
        residual_risks: legacy.submission.residual_risks
      }
    };
  },
  encode: jsonEntityDocumentCodec.encode
};

function upgradeLegacyBinding(binding: unknown, index: number, claimedAt: string): unknown {
  if (!binding || typeof binding !== "object") return binding;
  const record = binding as Record<string, unknown>;
  return {
    binding_id: typeof record.binding_id === "string" ? record.binding_id : `legacy:${index}`,
    session_ref: typeof record.session_ref === "string" ? record.session_ref : null,
    role: record.role,
    archive_status: record.archive_status,
    attached_at: typeof record.attached_at === "string" ? record.attached_at : claimedAt,
    session: record.session && typeof record.session === "object" ? record.session : null,
    capture_range: null
  };
}

export const executionDeclaration = decodeEntityDeclaration({
  kind: "execution",
  schema: ExecutionSchema,
  documentCodec: executionDocumentCodec,
  mutabilityContract: {
    identity: { mutability: "immutable", read: [{ kind: "show", path: "execution.identity" }], write: [], reason: "claim identity is immutable" },
    state: { mutability: "lifecycle", read: [{ kind: "projection", path: "state", queryable: true }], write: [{ kind: "lifecycle", operation: "transition" }], reason: "domain command lifecycle" },
    evidence: { mutability: "append-only", read: [{ kind: "show", path: "execution.evidence" }], write: [{ kind: "append", operation: "append" }], reason: "execution evidence is never overwritten" }
  },
  anchors: { entityRef: "execution/{taskId}/{executionId}", anchors: [] },
  dispositionMatrix: {
    entries: {
      retire: { level: "D1", action: "retire", supported: true, writeOpKinds: ["doc_write"], reason: "abandon preserves history" },
      supersede: { level: "D1", action: "supersede", supported: false, writeOpKinds: [], reason: "a new execution is a new round" },
      invalidate: { level: "D1", action: "invalidate", supported: false, writeOpKinds: [], reason: "not an execution disposition" },
      archive: { level: "D2", action: "archive", supported: false, writeOpKinds: [], reason: "follows host task" },
      tombstone: { level: "D3", action: "tombstone", supported: false, writeOpKinds: [], reason: "not in F3" },
      "hard-delete": { level: "D4", action: "hard-delete", supported: false, writeOpKinds: [], reason: "execution history is durable" }
    }
  },
  storageForm: "hosted-entity",
  rootResolver: {
    pathTemplate: "tasks/{taskId}/executions/{executionId}.md",
    identity: ["taskId", "executionId"],
    host: { entityKind: "task", pathTemplate: "tasks/{taskId}", identity: ["taskId"] }
  },
  projection: {
    table: "execution_projection",
    columns: [
      { name: "execution_id", field: "execution_id", type: "text", primaryKey: true },
      { name: "task_ref", field: "task_ref", type: "text" },
      { name: "state", field: "state", type: "text" },
      { name: "executor", field: "primary_actor.executor", type: "json" },
      { name: "primary_actor_json", field: "primary_actor", type: "json" },
      { name: "claimed_at", field: "claimed_at", type: "text" },
      { name: "submitted_at", field: "submitted_at", type: "text" },
      { name: "closed_at", field: "closed_at", type: "text" },
      { name: "session_bindings_json", field: "session_bindings", type: "json" },
      { name: "outputs_json", field: "outputs", type: "json" },
      { name: "submission_json", field: "submission", type: "json" }
    ]
  }
});

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

export const ExecutionSchema = Schema.Struct({
  schema: Schema.Literal("execution/v1"),
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
  session_bindings: Schema.Array(Schema.Unknown),
  outputs: Schema.Array(Schema.Unknown),
  submission: Schema.NullOr(Schema.Struct({
    summary: Schema.String,
    verification: Schema.Array(Schema.String),
    residual_risks: Schema.Array(Schema.String)
  }))
});

export const executionDeclaration = decodeEntityDeclaration({
  kind: "execution",
  schema: ExecutionSchema,
  documentCodec: jsonEntityDocumentCodec,
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
      { name: "executor", field: "primary_actor.executor", type: "json" }
    ]
  }
});

import { Schema } from "effect";
import { factConfidenceLevels, factMemoryClasses, factMemoryTags, factProvenanceRuntimes } from "../domain/fact-event.ts";

const ActorSchema = Schema.Struct({ principal: Schema.Struct({ personId: Schema.String }), executor: Schema.NullOr(Schema.Struct({ kind: Schema.Literal("agent"), id: Schema.String })) });
const SourceSchema = Schema.Union(Schema.Literal("local", "remote_direct"), Schema.Struct({ kind: Schema.Literal("assignment"), nodeId: Schema.String, assignmentId: Schema.String }));
export const FactEventSchema = Schema.Struct({ schema: Schema.Literal("fact-event/v1"), eventId: Schema.String, workspaceRevision: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
  opId: Schema.String, taskId: Schema.String, factId: Schema.String.pipe(Schema.pattern(/^F-[0-9A-HJKMNP-TV-Z]{8}$/u)), type: Schema.Literal("fact_recorded"), actor: ActorSchema, source: SourceSchema,
  occurredAt: Schema.String, payload: Schema.Struct({ statement: Schema.String, evidenceSource: Schema.String, observedAt: Schema.String,
    confidence: Schema.Literal(...factConfidenceLevels), memoryClass: Schema.Literal(...factMemoryClasses), memoryTags: Schema.Array(Schema.Literal(...factMemoryTags)),
    provenance: Schema.Array(Schema.Struct({ runtime: Schema.Literal(...factProvenanceRuntimes), sessionId: Schema.String, boundAt: Schema.String })).pipe(Schema.minItems(1)),
    supersedes: Schema.optional(Schema.Struct({ factRef: Schema.String, rationale: Schema.String })) }) });

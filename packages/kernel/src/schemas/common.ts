import { Schema } from "effect";

export const ActorKindSchema = Schema.Literal("agent", "human", "system");
export const LinkKindSchema = Schema.Literal("artifact", "commit", "review");
export const NonBlankStringSchema = Schema.String.pipe(Schema.pattern(/\S/u));
export const CurrentSessionRuntimeSchema = Schema.Literal("human", "claude-code", "codex", "zcode", "antigravity");

export const ActorRefSchema = Schema.Struct({
  kind: ActorKindSchema,
  id: Schema.String
});

export const ProvenanceEntrySchema = Schema.Struct({
  runtime: CurrentSessionRuntimeSchema,
  sessionId: NonBlankStringSchema,
  boundAt: NonBlankStringSchema
});

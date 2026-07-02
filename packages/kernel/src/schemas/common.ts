import { Schema } from "effect";

export const ActorKindSchema = Schema.Literal("agent", "human", "system");
export const LinkKindSchema = Schema.Literal("artifact", "commit", "review");

export const ActorRefSchema = Schema.Struct({
  kind: ActorKindSchema,
  id: Schema.String
});

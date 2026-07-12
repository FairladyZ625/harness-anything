import { Schema } from "effect";
import { NonBlankStringSchema } from "./common.ts";
import {
  ActorAxesSchema,
  ExecutorSourceSchema,
  PrincipalSourceSchema
} from "./actor-attribution.ts";
import { JournalPayloadRefSchema, WriteJournalOpKindSchema } from "./write-journal.ts";

export const AttributionEventSchema = Schema.Struct({
  schema: Schema.Literal("attribution-event/v1"),
  eventId: NonBlankStringSchema,
  opId: NonBlankStringSchema,
  journalRecordSchema: Schema.Literal("write-journal/v2"),
  entityId: NonBlankStringSchema,
  kind: WriteJournalOpKindSchema,
  actor: ActorAxesSchema,
  principalSource: PrincipalSourceSchema,
  executorSource: ExecutorSourceSchema,
  at: NonBlankStringSchema,
  recordedAt: NonBlankStringSchema,
  payloadHash: NonBlankStringSchema,
  payloadRef: JournalPayloadRefSchema
}).pipe(Schema.filter((event) => (
  event.actor.executor === null
    ? event.executorSource === "none"
    : event.executorSource === "client-asserted"
)));

export type AttributionEvent = Schema.Schema.Type<typeof AttributionEventSchema>;

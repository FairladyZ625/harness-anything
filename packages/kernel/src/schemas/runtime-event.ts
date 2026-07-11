import { Schema } from "effect";
import { CurrentSessionRuntimeSchema } from "./common.ts";
import {
  runtimeEventApprovalDecisions,
  runtimeEventInterruptActions,
  runtimeEventKinds,
  runtimeEventResultStatuses
} from "../domain/runtime-event.ts";

const OptionalString = Schema.optional(Schema.String);
const OptionalNumber = Schema.optional(Schema.Number);

const RuntimeEventPersonPrincipalSchema = Schema.Struct({
  personId: Schema.String,
  displayName: OptionalString,
  primaryEmail: OptionalString,
  providerId: OptionalString,
  credential: Schema.optional(Schema.Struct({
    kind: Schema.String,
    issuer: Schema.String,
    subject: Schema.String
  }))
});

const RuntimeEventActorSchema = Schema.Struct({
  principal: RuntimeEventPersonPrincipalSchema,
  executor: Schema.NullOr(Schema.Struct({
    kind: Schema.Literal("agent"),
    id: Schema.String
  })),
  responsibleHuman: Schema.String
});

const RuntimeEventActorAxesSchema = Schema.Struct({
  principal: Schema.NullOr(RuntimeEventPersonPrincipalSchema),
  executor: Schema.NullOr(Schema.Struct({
    runtime: Schema.Union(CurrentSessionRuntimeSchema, Schema.Literal("unknown")),
    sessionId: OptionalString
  })),
  responsibleHuman: Schema.NullOr(RuntimeEventPersonPrincipalSchema)
});

export const RuntimeEventRecordSchema = Schema.Struct({
  schema: Schema.Literal("runtime-event/v1"),
  eventId: Schema.String.pipe(Schema.pattern(/^evt_[A-Za-z0-9._-]{8,96}$/u)),
  recordedAt: Schema.String,
  kind: Schema.Literal(...runtimeEventKinds),
  actor: Schema.optional(RuntimeEventActorSchema),
  actorAxes: Schema.optional(RuntimeEventActorAxesSchema),
  session: Schema.Struct({
    sessionId: Schema.String,
    runtime: Schema.Union(CurrentSessionRuntimeSchema, Schema.Literal("unknown")),
    taskId: OptionalString,
    executionId: Schema.NullOr(Schema.String),
    reviewId: Schema.NullOr(Schema.String),
    decisionId: OptionalString,
    factRef: OptionalString
  }),
  turn: Schema.NullOr(Schema.Struct({
    turnId: Schema.String,
    index: OptionalNumber,
    role: Schema.optional(Schema.Literal("user", "assistant", "system", "tool", "unknown"))
  })),
  step: Schema.NullOr(Schema.Struct({
    stepId: Schema.String,
    parentStepId: OptionalString,
    name: OptionalString
  })),
  tool: Schema.NullOr(Schema.Struct({
    toolName: Schema.String,
    callId: OptionalString,
    errorCode: OptionalString
  })),
  approval: Schema.NullOr(Schema.Struct({
    approvalId: Schema.String,
    decision: Schema.Literal(...runtimeEventApprovalDecisions),
    scope: OptionalString
  })),
  interrupt: Schema.NullOr(Schema.Struct({
    interruptId: Schema.String,
    action: Schema.Literal(...runtimeEventInterruptActions),
    reason: OptionalString
  })),
  result: Schema.NullOr(Schema.Struct({
    status: Schema.Literal(...runtimeEventResultStatuses),
    summary: OptionalString,
    errorCode: OptionalString
  })),
  cost: Schema.NullOr(Schema.Struct({
    inputTokens: OptionalNumber,
    outputTokens: OptionalNumber,
    totalTokens: OptionalNumber,
    wallMs: OptionalNumber,
    model: OptionalString,
    amountUsd: OptionalNumber
  }))
});

export type RuntimeEventRecordDocument = Schema.Schema.Type<typeof RuntimeEventRecordSchema>;

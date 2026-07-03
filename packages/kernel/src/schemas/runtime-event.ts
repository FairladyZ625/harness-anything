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

export const RuntimeEventRecordSchema = Schema.Struct({
  schema: Schema.Literal("runtime-event/v1"),
  eventId: Schema.String.pipe(Schema.pattern(/^evt_[A-Za-z0-9._-]{8,96}$/u)),
  recordedAt: Schema.String,
  kind: Schema.Literal(...runtimeEventKinds),
  session: Schema.Struct({
    sessionId: Schema.String,
    runtime: Schema.Union(CurrentSessionRuntimeSchema, Schema.Literal("unknown")),
    taskId: OptionalString,
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

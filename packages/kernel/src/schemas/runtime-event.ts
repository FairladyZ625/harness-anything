import { Schema } from "effect";
import { CurrentSessionRuntimeSchema } from "./common.ts";
import { ActorAxesSchema } from "./actor-attribution.ts";
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

// V1-only reader shape. Runtime/session identity remains here solely so legacy
// rows stay readable; active v2 writers use stable ActorAxesSchema instead.
const LegacyRuntimeEventActorAxesSchema = Schema.Struct({
  principal: Schema.NullOr(RuntimeEventPersonPrincipalSchema),
  executor: Schema.NullOr(Schema.Struct({
    runtime: Schema.Union(CurrentSessionRuntimeSchema, Schema.Literal("unknown")),
    sessionId: OptionalString
  })),
  responsibleHuman: Schema.NullOr(RuntimeEventPersonPrincipalSchema)
});

export const RuntimeLeaseEventSchema = Schema.Struct({
  action: Schema.Literal("reserved", "activated", "renewed", "released", "expired", "reconciled"),
  taskId: Schema.String,
  executionId: Schema.String,
  phase: Schema.Literal("reserving", "active", "released", "expired"),
  acquiredVia: Schema.Literal("claim"),
  acquiredAt: Schema.String,
  leaseExpiresAt: Schema.String,
  releasedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  version: Schema.String,
  previousHolder: Schema.NullOr(ActorAxesSchema)
});

const RuntimeEventFields = {
  eventId: Schema.String.pipe(Schema.pattern(/^evt_[A-Za-z0-9._-]{8,96}$/u)),
  recordedAt: Schema.String,
  kind: Schema.Literal(...runtimeEventKinds),
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
    errorCode: OptionalString,
    deprecated: Schema.optional(Schema.Boolean)
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
} as const;

// V1 remains the active persistence contract until Phase 6. Its two legacy
// actor fields are isolated here so the domain no longer publishes competing
// actor models.
export const RuntimeEventRecordSchema = Schema.Struct({
  schema: Schema.Literal("runtime-event/v1"),
  ...RuntimeEventFields,
  kind: Schema.Literal("session", "turn", "step", "tool", "approval", "interrupt", "result", "cost"),
  actor: Schema.optional(RuntimeEventActorSchema),
  actorAxes: Schema.optional(LegacyRuntimeEventActorAxesSchema)
});

// Phase 1 publishes the v2 type/schema only. No current append path selects it.
export const RuntimeEventRecordV2Schema = Schema.Struct({
  schema: Schema.Literal("runtime-event/v2"),
  ...RuntimeEventFields,
  actor: ActorAxesSchema,
  lease: Schema.optional(RuntimeLeaseEventSchema)
}).pipe(Schema.filter((event) => {
  if (event.kind !== "lease") return event.lease === undefined;
  return event.lease !== undefined &&
    event.lease.executionId === event.session.executionId &&
    event.lease.taskId === event.session.taskId;
}));

export type RuntimeEventRecord = Schema.Schema.Type<typeof RuntimeEventRecordSchema>;
export type RuntimeEventRecordV2 = Schema.Schema.Type<typeof RuntimeEventRecordV2Schema>;
export type RuntimeLeaseEvent = Schema.Schema.Type<typeof RuntimeLeaseEventSchema>;
export type RuntimeEventRecordDocument = RuntimeEventRecord | RuntimeEventRecordV2;

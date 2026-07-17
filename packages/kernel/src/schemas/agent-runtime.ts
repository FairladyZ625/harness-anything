// @slice-activation PLT-AgentRuntime W-A1 canonical runtime resource schema consumed by W-A2 adapters and W-B projections.
import { Schema } from "effect";
import {
  runtimeCapabilityNames,
  runtimeProtocolFamilies
} from "../domain/agent-runtime.ts";

const RuntimeStateEvidenceSchema = Schema.Struct({
  state: Schema.Union(Schema.Boolean, Schema.Literal("unknown")),
  reason: Schema.String,
  observedAt: Schema.optional(Schema.String)
});

const RuntimeCapabilitySchema = Schema.Struct({
  name: Schema.Literal(...runtimeCapabilityNames),
  state: Schema.Literal("supported", "unsupported", "unknown")
});

const RuntimeKindSchema = Schema.Struct({
  kindId: Schema.String,
  displayName: Schema.String,
  protocolFamily: Schema.Literal(...runtimeProtocolFamilies),
  executableNames: Schema.Array(Schema.String).pipe(Schema.minItems(1)),
  environmentOverride: Schema.String,
  appBundleCandidates: Schema.Array(Schema.String),
  capabilities: Schema.Array(RuntimeCapabilitySchema),
  authenticationProfiles: Schema.Array(Schema.Struct({
    profileKind: Schema.String,
    label: Schema.String
  }))
});

const RuntimeInstallationSchema = Schema.Struct({
  installationId: Schema.String,
  kindId: Schema.String,
  hostId: Schema.Literal("local"),
  executablePath: Schema.String,
  version: Schema.optional(Schema.String),
  discoveredBy: Schema.Literal("environment-override", "path", "login-shell", "app-bundle"),
  states: Schema.Struct({
    installed: RuntimeStateEvidenceSchema,
    authenticated: RuntimeStateEvidenceSchema,
    running: RuntimeStateEvidenceSchema,
    attachable: RuntimeStateEvidenceSchema
  })
});

const RuntimeSessionSchema = Schema.Struct({
  runtimeSessionId: Schema.String,
  kindId: Schema.String,
  installationId: Schema.String,
  providerSessionId: Schema.optional(Schema.String),
  workdir: Schema.optional(Schema.String),
  processWitness: Schema.Struct({
    state: Schema.Literal("alive", "exited", "unknown"),
    pid: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.greaterThan(0))),
    startedAt: Schema.optional(Schema.String),
    heartbeatAt: Schema.optional(Schema.String),
    exitedAt: Schema.optional(Schema.String),
    exitCode: Schema.optional(Schema.NullOr(Schema.Number.pipe(Schema.int())))
  }),
  attachable: RuntimeStateEvidenceSchema,
  clientBinding: Schema.optional(Schema.Struct({
    assertion: Schema.Literal("client-asserted"),
    taskId: Schema.optional(Schema.String),
    executionId: Schema.optional(Schema.String)
  }))
});

export const AgentRuntimeInventorySchema = Schema.Struct({
  schema: Schema.Literal("agent-runtime-inventory/v1"),
  generatedAt: Schema.String,
  kinds: Schema.Array(RuntimeKindSchema),
  installations: Schema.Array(RuntimeInstallationSchema),
  sessions: Schema.Array(RuntimeSessionSchema)
});

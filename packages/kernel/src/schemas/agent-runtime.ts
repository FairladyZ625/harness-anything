// @slice-activation PLT-AgentRuntime W-A1 canonical runtime resource schema consumed by W-A2 adapters and W-B projections.
import { Schema } from "effect";
import {
  runtimeCapabilityNames,
  runtimeProtocolFamilies,
  type AgentRuntimeInventory,
  type RuntimeInstallation,
  type RuntimeKind,
  type RuntimeSession
} from "../domain/agent-runtime.ts";

const IdentifierSchema = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u));
const NonBlankStringSchema = Schema.String.pipe(Schema.pattern(/\S/u));
const Rfc3339TimestampSchema = Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u));
const PositivePidSchema = Schema.Number.pipe(Schema.int(), Schema.greaterThan(0));
const DiscoverySourceSchema = Schema.Literal("environment-override", "path", "login-shell", "app-bundle");

const RuntimeCapabilitySchema = Schema.Struct({
  name: Schema.Literal(...runtimeCapabilityNames),
  state: Schema.Literal("supported", "unsupported", "unknown")
});

export const RuntimeKindSchema = Schema.Struct({
  kindId: IdentifierSchema,
  displayName: NonBlankStringSchema,
  protocolFamily: Schema.Literal(...runtimeProtocolFamilies),
  executableNames: Schema.Array(NonBlankStringSchema).pipe(Schema.minItems(1)),
  environmentOverride: Schema.String.pipe(Schema.pattern(/^[A-Z][A-Z0-9_]*$/u)),
  appBundleCandidates: Schema.Array(NonBlankStringSchema),
  capabilities: Schema.Array(RuntimeCapabilitySchema),
  authenticationProfiles: Schema.Array(Schema.Struct({
    profileKind: IdentifierSchema,
    label: NonBlankStringSchema
  }))
}).pipe(Schema.filter((kind) => {
  const capabilities = kind.capabilities.map(({ name }) => name);
  const profiles = kind.authenticationProfiles.map(({ profileKind }) => profileKind);
  return new Set(capabilities).size === capabilities.length && new Set(profiles).size === profiles.length;
}, { message: () => "runtime kind capability and authentication profile names must be unique" }));

const ExecutableObservationSchema = Schema.Struct({
  kind: Schema.Literal("executable-probe"),
  source: DiscoverySourceSchema,
  executablePath: NonBlankStringSchema,
  outcome: Schema.Literal("executable", "not-executable")
});
const AuthenticationObservationSchema = Schema.Struct({
  kind: Schema.Literal("authentication-probe"),
  profileKind: Schema.optional(IdentifierSchema),
  outcome: Schema.Literal("authenticated", "not-authenticated", "invalid")
});
const ProcessObservationSchema = Schema.Struct({
  kind: Schema.Literal("process-probe"),
  outcome: Schema.Literal("alive", "exited", "not-found"),
  runtimeSessionId: Schema.optional(IdentifierSchema),
  pid: Schema.optional(PositivePidSchema)
});
const AttachObservationSchema = Schema.Struct({
  kind: Schema.Literal("attach-channel-probe"),
  outcome: Schema.Literal("available", "unavailable"),
  runtimeSessionId: Schema.optional(IdentifierSchema)
});

const RuntimeInstalledEvidenceSchema = Schema.Union(
  Schema.Struct({ criterion: Schema.Literal("executable-probe"), state: Schema.Literal(true), reason: Schema.Literal("executable-verified"), observedAt: Rfc3339TimestampSchema, observation: ExecutableObservationSchema.pipe(Schema.filter(({ outcome }) => outcome === "executable")) }),
  Schema.Struct({ criterion: Schema.Literal("executable-probe"), state: Schema.Literal(false), reason: Schema.Literal("executable-not-verified"), observedAt: Rfc3339TimestampSchema, observation: ExecutableObservationSchema.pipe(Schema.filter(({ outcome }) => outcome === "not-executable")) }),
  Schema.Struct({ criterion: Schema.Literal("executable-probe"), state: Schema.Literal("unknown"), reason: Schema.Literal("discovery-not-run", "discovery-probe-failed"), observedAt: Schema.optional(Rfc3339TimestampSchema) })
);
const RuntimeAuthenticatedEvidenceSchema = Schema.Union(
  Schema.Struct({ criterion: Schema.Literal("authentication-probe"), state: Schema.Literal(true), reason: Schema.Literal("profile-authenticated"), observedAt: Rfc3339TimestampSchema, observation: AuthenticationObservationSchema.pipe(Schema.filter(({ outcome }) => outcome === "authenticated")) }),
  Schema.Struct({ criterion: Schema.Literal("authentication-probe"), state: Schema.Literal(false), reason: Schema.Literal("profile-not-authenticated", "profile-invalid"), observedAt: Rfc3339TimestampSchema, observation: AuthenticationObservationSchema.pipe(Schema.filter(({ outcome }) => outcome !== "authenticated")) }),
  Schema.Struct({ criterion: Schema.Literal("authentication-probe"), state: Schema.Literal("unknown"), reason: Schema.Literal("authentication-not-probed", "authentication-unverified", "authentication-probe-failed"), observedAt: Schema.optional(Rfc3339TimestampSchema) })
);
const RuntimeRunningEvidenceSchema = Schema.Union(
  Schema.Struct({ criterion: Schema.Literal("process-probe"), state: Schema.Literal(true), reason: Schema.Literal("process-alive"), observedAt: Rfc3339TimestampSchema, observation: ProcessObservationSchema.pipe(Schema.filter(({ outcome }) => outcome === "alive")) }),
  Schema.Struct({ criterion: Schema.Literal("process-probe"), state: Schema.Literal(false), reason: Schema.Literal("process-exited", "process-not-found"), observedAt: Rfc3339TimestampSchema, observation: ProcessObservationSchema.pipe(Schema.filter(({ outcome }) => outcome !== "alive")) }),
  Schema.Struct({ criterion: Schema.Literal("process-probe"), state: Schema.Literal("unknown"), reason: Schema.Literal("process-witness-unavailable"), observedAt: Schema.optional(Rfc3339TimestampSchema) })
);
const RuntimeAttachableEvidenceSchema = Schema.Union(
  Schema.Struct({ criterion: Schema.Literal("attach-channel-probe"), state: Schema.Literal(true), reason: Schema.Literal("attach-channel-available"), observedAt: Rfc3339TimestampSchema, observation: AttachObservationSchema.pipe(Schema.filter(({ outcome }) => outcome === "available")) }),
  Schema.Struct({ criterion: Schema.Literal("attach-channel-probe"), state: Schema.Literal(false), reason: Schema.Literal("attach-channel-unavailable"), observedAt: Rfc3339TimestampSchema, observation: AttachObservationSchema.pipe(Schema.filter(({ outcome }) => outcome === "unavailable")) }),
  Schema.Struct({ criterion: Schema.Literal("attach-channel-probe"), state: Schema.Literal("unknown"), reason: Schema.Literal("attach-channel-not-probed", "attach-channel-probe-failed"), observedAt: Schema.optional(Rfc3339TimestampSchema) })
);

const RuntimeProcessWitnessSchema = Schema.Union(
  Schema.Struct({ state: Schema.Literal("alive"), pid: PositivePidSchema, startedAt: Rfc3339TimestampSchema, heartbeatAt: Schema.optional(Rfc3339TimestampSchema) }),
  Schema.Struct({ state: Schema.Literal("exited"), pid: Schema.optional(PositivePidSchema), startedAt: Schema.optional(Rfc3339TimestampSchema), heartbeatAt: Schema.optional(Rfc3339TimestampSchema), exitedAt: Rfc3339TimestampSchema, exitCode: Schema.optional(Schema.NullOr(Schema.Number.pipe(Schema.int()))) }),
  Schema.Struct({ state: Schema.Literal("unknown") })
);

export const RuntimeInstallationSchema = Schema.Struct({
  installationId: IdentifierSchema,
  kindId: IdentifierSchema,
  hostId: Schema.Literal("local"),
  executablePath: NonBlankStringSchema,
  version: Schema.optional(NonBlankStringSchema),
  discoveredBy: DiscoverySourceSchema,
  states: Schema.Struct({
    installed: RuntimeInstalledEvidenceSchema,
    authenticated: RuntimeAuthenticatedEvidenceSchema,
    running: RuntimeRunningEvidenceSchema,
    attachable: RuntimeAttachableEvidenceSchema
  })
});

export const RuntimeSessionSchema = Schema.Struct({
  runtimeSessionId: IdentifierSchema,
  kindId: IdentifierSchema,
  installationId: IdentifierSchema,
  providerSessionId: Schema.optional(NonBlankStringSchema),
  workdir: Schema.optional(NonBlankStringSchema),
  processWitness: RuntimeProcessWitnessSchema,
  attachable: RuntimeAttachableEvidenceSchema,
  clientBinding: Schema.optional(Schema.Struct({
    assertion: Schema.Literal("client-asserted"),
    taskId: Schema.optional(IdentifierSchema),
    executionId: Schema.optional(IdentifierSchema)
  }))
});

export const AgentRuntimeInventorySchema = Schema.Struct({
  schema: Schema.Literal("agent-runtime-inventory/v1"),
  generatedAt: Rfc3339TimestampSchema,
  kinds: Schema.Array(RuntimeKindSchema),
  installations: Schema.Array(RuntimeInstallationSchema),
  sessions: Schema.Array(RuntimeSessionSchema)
}).pipe(Schema.filter((inventory) => {
  const kindIds = inventory.kinds.map(({ kindId }) => kindId);
  const installationIds = inventory.installations.map(({ installationId }) => installationId);
  const sessionIds = inventory.sessions.map(({ runtimeSessionId }) => runtimeSessionId);
  if (new Set(kindIds).size !== kindIds.length || new Set(installationIds).size !== installationIds.length || new Set(sessionIds).size !== sessionIds.length) return false;
  const kinds = new Set(kindIds);
  const installations = new Map(inventory.installations.map((installation) => [installation.installationId, installation.kindId]));
  return inventory.installations.every(({ kindId }) => kinds.has(kindId))
    && inventory.sessions.every((session) => installations.get(session.installationId) === session.kindId);
}, { message: () => "runtime inventory ids must be unique and all installation/session references must resolve" }));

const strictDecode = { onExcessProperty: "error" } as const;
export const parseRuntimeKind = (input: unknown): RuntimeKind => Schema.decodeUnknownSync(RuntimeKindSchema, strictDecode)(input) as RuntimeKind;
export const parseRuntimeInstallation = (input: unknown): RuntimeInstallation => Schema.decodeUnknownSync(RuntimeInstallationSchema, strictDecode)(input) as RuntimeInstallation;
export const parseRuntimeSession = (input: unknown): RuntimeSession => Schema.decodeUnknownSync(RuntimeSessionSchema, strictDecode)(input) as RuntimeSession;
export const parseAgentRuntimeInventory = (input: unknown): AgentRuntimeInventory => Schema.decodeUnknownSync(AgentRuntimeInventorySchema, strictDecode)(input) as AgentRuntimeInventory;

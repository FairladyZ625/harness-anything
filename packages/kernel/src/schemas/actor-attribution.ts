import { Schema } from "effect";
import { NonBlankStringSchema } from "./common.ts";

export const PersonRefSchema = Schema.Struct({
  kind: Schema.Literal("person"),
  personId: NonBlankStringSchema
});

export const AgentRefSchema = Schema.Struct({
  kind: Schema.Literal("agent"),
  id: NonBlankStringSchema
});

export const ActorAxesSchema = Schema.Struct({
  principal: PersonRefSchema,
  executor: Schema.NullOr(AgentRefSchema)
});

const DaemonAuthenticatedPrincipalSourceSchema = Schema.Struct({
  kind: Schema.Literal("daemon-authenticated"),
  providerId: NonBlankStringSchema,
  credentialFingerprint: NonBlankStringSchema
});

const LocalConfiguredPrincipalSourceSchema = Schema.Struct({
  kind: Schema.Literal("local-configured"),
  authority: Schema.Literal("persons.yaml", "people.yaml-legacy", "harness.yaml"),
  authoritySha256: NonBlankStringSchema
});

const MigrationPrincipalSourceSchema = Schema.Struct({
  kind: Schema.Literal("migration"),
  evidenceRef: NonBlankStringSchema
});

export const PrincipalSourceSchema = Schema.Union(
  DaemonAuthenticatedPrincipalSourceSchema,
  LocalConfiguredPrincipalSourceSchema,
  MigrationPrincipalSourceSchema
);

export const ExecutorSourceSchema = Schema.Literal("client-asserted", "none");

export const WriteAttributionSchema = Schema.Struct({
  actor: ActorAxesSchema,
  principalSource: PrincipalSourceSchema,
  executorSource: ExecutorSourceSchema
}).pipe(Schema.filter((attribution) => (
  attribution.actor.executor === null
    ? attribution.executorSource === "none"
    : attribution.executorSource === "client-asserted"
)));

export type PersonRef = Schema.Schema.Type<typeof PersonRefSchema>;
export type AgentRef = Schema.Schema.Type<typeof AgentRefSchema>;
export type ActorAxes = Schema.Schema.Type<typeof ActorAxesSchema>;
export type PrincipalSource = Schema.Schema.Type<typeof PrincipalSourceSchema>;
export type ExecutorSource = Schema.Schema.Type<typeof ExecutorSourceSchema>;
export type WriteAttribution = Schema.Schema.Type<typeof WriteAttributionSchema>;

export interface OperationalActor {
  readonly scope: "operational";
  readonly kind: "agent" | "system";
  readonly id: string;
}

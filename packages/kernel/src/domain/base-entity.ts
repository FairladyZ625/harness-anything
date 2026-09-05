import { packageDispositions, type PackageDisposition } from "./package-disposition.ts";
import { timestamp } from "./timestamp.ts";
import { validateActorIdentity, type ActorIdentity } from "./actor-identity.ts";
import { isRecord, type WriteSource } from "./write-chain.contract.ts";
import { entityFreshnesses, type EntityFreshness } from "./entity-freshness.ts";

export const ENTITY_ID_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";
export const entityDispositions = packageDispositions;
export type EntityDisposition = PackageDisposition;
export type EntityResidency = "ledger" | "runtime-local" | "projection";
export type EntityResidencyFacets = Readonly<Record<string, EntityResidency>>;

export const baseEntityActionIds = Object.freeze([
  "pin",
  "unpin",
  "relate",
  "unrelate",
  "update",
  "archive",
  "explain",
] as const);
export type BaseEntityActionId = (typeof baseEntityActionIds)[number];

export interface RelationEndpointEligibility {
  readonly eligible: true;
}

export const relationEndpointEligibility: RelationEndpointEligibility = Object.freeze({ eligible: true });

export interface EntityIdentityContract<K extends string = string> {
  readonly field: string;
  readonly pattern: string;
  readonly refTemplate: `${K}/{id}`;
  readonly refPattern?: string;
  readonly anchorPattern?: string;
}

export interface EntityIdentity<K extends string = string, I extends string = string> {
  readonly id: I;
  readonly kind: K;
  readonly ref: `${K}/${string}`;
}

export interface EntityProvenance {
  readonly actor: ActorIdentity;
  readonly at: string;
  readonly source: WriteSource;
}

export interface BaseEntity<
  K extends string = string,
  I extends string = string,
  R extends EntityResidencyFacets = EntityResidencyFacets,
> extends EntityIdentity<K, I> {
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly disposition: EntityDisposition;
  readonly provenance: EntityProvenance;
  readonly pinned: boolean;
  readonly relationEndpoint: RelationEndpointEligibility;
  readonly residency: R;
  readonly freshness: EntityFreshness;
}

export type BaseEntityPinState = Pick<BaseEntity, "pinned">;

export interface EntityTypeContract<E extends BaseEntity = BaseEntity> {
  readonly kind: E["kind"];
  readonly residency: E["residency"];
  readonly id: EntityIdentityContract<E["kind"]>;
  readonly relationEndpoint: E["relationEndpoint"];
  readonly baseActions: readonly BaseEntityActionId[];
}

export type EntityFromTypeContract<C extends EntityTypeContract> = BaseEntity<C["kind"], string, C["residency"]>;

export type EntityTypeContractBase<E extends BaseEntity> = Omit<EntityTypeContract<E>, "kind">;

export function baseEntityTypeContract<K extends string, R extends EntityResidencyFacets>(
  identity: EntityIdentityContract<K>,
  residency: R,
): EntityTypeContractBase<BaseEntity<K, string, R>> {
  return Object.freeze({
    id: identity,
    residency,
    relationEndpoint: relationEndpointEligibility,
    baseActions: baseEntityActionIds,
  });
}

const authoredResidency = Object.freeze({ authored: "ledger" as const });
const authoredLiveResidency = Object.freeze({ authored: "ledger" as const, live: "runtime-local" as const });
const scheduleResidency = Object.freeze({
  definition: "ledger" as const,
  execution: "runtime-local" as const,
  runView: "projection" as const,
});
const taskIdentity = Object.freeze({
  field: "task_id",
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
  refTemplate: "task/{id}" as const,
  refPattern: "^(?:task_[A-Za-z0-9_-]+|[A-Za-z0-9][A-Za-z0-9_-]*-[A-Za-z0-9_-]+)$",
});
const factIdentity = Object.freeze({
  field: "factId",
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
  refTemplate: "fact/{id}" as const,
  refPattern: "^F-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
});
const decisionIdentity = Object.freeze({
  field: "decisionId",
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
  refTemplate: "decision/{id}" as const,
  refPattern: "^(?:dec_[A-Za-z0-9_-]+|[A-Za-z0-9][A-Za-z0-9_-]*-[A-Za-z0-9_-]+)$",
  anchorPattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$",
});
const slugIdentity = <K extends "agent" | "squad" | "policy">(kind: K, field = "id") =>
  Object.freeze({ field, pattern: ENTITY_ID_PATTERN, refTemplate: `${kind}/{id}` as const });
const executionIdentity = Object.freeze({
  field: "executionId",
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
  refTemplate: "execution/{id}" as const,
});
const reviewIdentity = Object.freeze({
  field: "reviewId",
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
  refTemplate: "review/{id}" as const,
});
const runtimeSessionIdentity = Object.freeze({
  field: "runtimeSessionId",
  pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$",
  refTemplate: "runtime-session/{id}" as const,
});
const runtimeInstanceIdentity = Object.freeze({
  field: "instanceId",
  pattern: ENTITY_ID_PATTERN,
  refTemplate: "runtime-instance/{id}" as const,
});
const scheduleIdentity = Object.freeze({
  field: "scheduleId",
  pattern: ENTITY_ID_PATTERN,
  refTemplate: "schedule/{id}" as const,
});
const settingsIdentity = Object.freeze({
  field: "settingsId",
  pattern: "^repository$",
  refTemplate: "settings/{id}" as const,
});
const personIdentity = Object.freeze({
  field: "personId",
  pattern: "^[A-Za-z][A-Za-z0-9_-]{0,62}$",
  refTemplate: "person/{id}" as const,
});
const relationIdentity = Object.freeze({
  field: "id",
  pattern: "^rel_[0-9a-f]{16}$",
  refTemplate: "relation/{id}" as const,
});

export const entityTypeContracts = Object.freeze([
  { kind: "task", ...baseEntityTypeContract(taskIdentity, authoredResidency) },
  { kind: "fact", ...baseEntityTypeContract(factIdentity, authoredResidency) },
  { kind: "decision", ...baseEntityTypeContract(decisionIdentity, authoredResidency) },
  { kind: "agent", ...baseEntityTypeContract(slugIdentity("agent"), authoredResidency) },
  { kind: "squad", ...baseEntityTypeContract(slugIdentity("squad"), authoredResidency) },
  { kind: "policy", ...baseEntityTypeContract(slugIdentity("policy"), authoredResidency) },
  { kind: "execution", ...baseEntityTypeContract(executionIdentity, authoredLiveResidency) },
  { kind: "review", ...baseEntityTypeContract(reviewIdentity, authoredResidency) },
  { kind: "runtime-session", ...baseEntityTypeContract(runtimeSessionIdentity, authoredLiveResidency) },
  {
    kind: "runtime-instance",
    ...baseEntityTypeContract(runtimeInstanceIdentity, Object.freeze({ configuration: "runtime-local" as const })),
  },
  { kind: "schedule", ...baseEntityTypeContract(scheduleIdentity, scheduleResidency) },
  {
    kind: "settings",
    ...baseEntityTypeContract(
      settingsIdentity,
      Object.freeze({ authored: "ledger" as const, current: "projection" as const }),
    ),
  },
  { kind: "person", ...baseEntityTypeContract(personIdentity, authoredResidency) },
  {
    kind: "relation",
    ...baseEntityTypeContract(
      relationIdentity,
      Object.freeze({ history: "ledger" as const, graph: "projection" as const }),
    ),
  },
] as const satisfies readonly EntityTypeContract[]);

export type RegisteredEntity = EntityFromTypeContract<(typeof entityTypeContracts)[number]>;
export type EntityKind = RegisteredEntity["kind"];

export function requireEntityTypeContract<K extends EntityKind>(
  kind: K,
): Extract<(typeof entityTypeContracts)[number], { readonly kind: K }> {
  const contract = entityTypeContracts.find((candidate) => candidate.kind === kind);
  if (!contract) throw new Error(`Entity kind ${kind} has no type contract.`);
  return contract as Extract<(typeof entityTypeContracts)[number], { readonly kind: K }>;
}

export interface BaseEntityEventCut<K extends string = string, I extends string = string> {
  readonly kind: K;
  readonly id: I;
  readonly workspaceRevision: number;
  readonly occurredAt: string;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly pinned: boolean;
  readonly disposition: EntityDisposition;
}

export function projectBaseEntityAtCut<E extends BaseEntity>(
  contract: EntityTypeContract<E>,
  input: unknown,
  previous: E | null = null,
): E {
  const cut = parseEventCut(contract, input);
  if (previous !== null) {
    const previousIssues = validateBaseEntity(contract, previous);
    if (previousIssues.length) throw new Error(previousIssues.join("; "));
    if (previous.kind !== cut.kind || previous.id !== cut.id)
      throw new Error("BaseEntity projection identity cannot change across event cuts");
    if (cut.workspaceRevision <= previous.revision)
      throw new Error("BaseEntity projection revision must increase monotonically");
    if (Date.parse(cut.occurredAt) < Date.parse(previous.updatedAt))
      throw new Error("BaseEntity projection updatedAt cannot precede the prior cut");
  }
  const projected = Object.freeze({
    id: cut.id,
    kind: cut.kind,
    ref: entityRef(contract.id, cut.id, cut.kind),
    revision: cut.workspaceRevision,
    createdAt: previous?.createdAt ?? cut.occurredAt,
    updatedAt: cut.occurredAt,
    disposition: cut.disposition,
    provenance: Object.freeze({ actor: cut.actor, at: cut.occurredAt, source: cut.source }),
    pinned: cut.pinned,
    relationEndpoint: contract.relationEndpoint,
    residency: contract.residency,
    freshness: "current",
  }) as E;
  const issues = validateBaseEntity(contract, projected);
  if (issues.length) throw new Error(issues.join("; "));
  return projected;
}

export function rebuildBaseEntityProjection<E extends BaseEntity>(
  contract: EntityTypeContract<E>,
  cuts: readonly unknown[],
): E {
  if (cuts.length === 0) throw new Error("BaseEntity projection rebuild requires at least one event cut");
  return cuts.reduce<E | null>((current, cut) => projectBaseEntityAtCut(contract, cut, current), null) as E;
}

export function validateBaseEntity<E extends BaseEntity>(
  contract: EntityTypeContract<E>,
  value: unknown,
): readonly string[] {
  if (!isRecord(value)) return ["BaseEntity projection must be an object"];
  const required = [
    "id",
    "kind",
    "ref",
    "revision",
    "createdAt",
    "updatedAt",
    "disposition",
    "provenance",
    "pinned",
    "relationEndpoint",
    "residency",
    "freshness",
  ];
  if (required.some((field) => !Object.hasOwn(value, field))) return ["BaseEntity projection fields are incomplete"];
  const issues: string[] = [];
  if (value.kind !== contract.kind || typeof value.id !== "string" || !matchesIdentity(contract.id, value.id))
    issues.push("BaseEntity projection identity is invalid");
  else if (value.ref !== entityRef(contract.id, value.id, contract.kind))
    issues.push("BaseEntity projection ref does not match its identity");
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1)
    issues.push("BaseEntity projection revision must be a positive safe integer");
  if (!timestamp(value.createdAt) || !timestamp(value.updatedAt))
    issues.push("BaseEntity projection timestamps must be ISO-8601 UTC instants");
  else if (Date.parse(value.createdAt) > Date.parse(value.updatedAt))
    issues.push("BaseEntity projection createdAt cannot follow updatedAt");
  if (!entityDispositions.includes(value.disposition as EntityDisposition))
    issues.push("BaseEntity projection disposition is invalid");
  if (typeof value.pinned !== "boolean") issues.push("BaseEntity projection pinned must be a boolean");
  if (!entityFreshnesses.includes(value.freshness as EntityFreshness))
    issues.push("BaseEntity projection freshness is invalid");
  if (!isRecord(value.relationEndpoint) || value.relationEndpoint.eligible !== true)
    issues.push("BaseEntity projection relation endpoint eligibility is invalid");
  const residency = isRecord(value.residency) ? value.residency : null;
  if (
    residency === null ||
    Object.keys(residency).length !== Object.keys(contract.residency).length ||
    Object.entries(contract.residency).some(([facet, expected]) => residency[facet] !== expected)
  )
    issues.push("BaseEntity projection residency does not match its kind");
  if (!isRecord(value.provenance)) issues.push("BaseEntity projection provenance is invalid");
  else {
    if (validateActorIdentity(value.provenance.actor).length)
      issues.push("BaseEntity projection provenance actor is invalid");
    if (value.provenance.at !== value.updatedAt)
      issues.push("BaseEntity projection provenance must identify the current event cut");
    if (!validWriteSource(value.provenance.source)) issues.push("BaseEntity projection provenance source is invalid");
  }
  return issues;
}

export function assertUniqueBaseEntityIdentities(values: readonly BaseEntity[]): void {
  const identities = new Set<string>();
  for (const value of values) {
    const identity = `${value.kind}\u0000${value.id}`;
    if (identities.has(identity)) throw new Error(`duplicate BaseEntity identity: ${value.kind}/${value.id}`);
    identities.add(identity);
  }
}

function parseEventCut<E extends BaseEntity>(
  contract: EntityTypeContract<E>,
  value: unknown,
): BaseEntityEventCut<E["kind"]> {
  const fields = ["kind", "id", "workspaceRevision", "occurredAt", "actor", "source", "pinned", "disposition"];
  if (
    !isRecord(value) ||
    fields.some((field) => !Object.hasOwn(value, field)) ||
    Object.keys(value).some((field) => !fields.includes(field))
  )
    throw new Error("BaseEntity event cut fields are incomplete or unknown");
  if (value.kind !== contract.kind || typeof value.id !== "string" || !matchesIdentity(contract.id, value.id))
    throw new Error("BaseEntity event cut identity is invalid");
  if (!Number.isSafeInteger(value.workspaceRevision) || (value.workspaceRevision as number) < 1)
    throw new Error("BaseEntity event cut revision must be a positive safe integer");
  if (!timestamp(value.occurredAt)) throw new Error("BaseEntity event cut occurredAt must be an ISO-8601 UTC instant");
  if (validateActorIdentity(value.actor).length) throw new Error("BaseEntity event cut actor is invalid");
  if (!validWriteSource(value.source)) throw new Error("BaseEntity event cut source is invalid");
  if (typeof value.pinned !== "boolean") throw new Error("BaseEntity event cut pinned must be a boolean");
  if (!entityDispositions.includes(value.disposition as EntityDisposition))
    throw new Error("BaseEntity event cut disposition is invalid");
  return value as unknown as BaseEntityEventCut<E["kind"]>;
}

function entityRef<K extends string>(identity: EntityIdentityContract<K>, id: string, kind: K): `${K}/${string}` {
  if (!identity.refTemplate.includes("{id}")) throw new Error(`${kind} ref template has no identity slot`);
  const ref = identity.refTemplate.replace("{id}", id);
  if (ref.includes("{id}")) throw new Error(`${kind} ref template has more than one identity slot`);
  return ref as `${K}/${string}`;
}

function matchesIdentity(identity: EntityIdentityContract, id: string): boolean {
  return new RegExp(identity.refPattern ?? identity.pattern, "u").test(id);
}

function validWriteSource(value: unknown): value is WriteSource {
  if (value === "local" || value === "remote_direct" || value === "migration-import/v1") return true;
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "assignment") return typeof value.nodeId === "string" && typeof value.assignmentId === "string";
  return (
    value.kind === "watch_session" &&
    typeof value.sessionId === "string" &&
    typeof value.path === "string" &&
    typeof value.fingerprint === "string"
  );
}

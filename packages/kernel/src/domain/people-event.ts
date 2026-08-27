import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { eventObjectTarget } from "../layout/ledger-object-layout.ts";
import {
  applyPeopleRosterAction,
  parsePeopleRosterDocument,
  PEOPLE_ROSTER_PATH,
  serializePeopleRosterDocument,
  type AppliedPeopleRosterAction,
  type PeopleRosterAction,
  type PeopleRosterDocumentV1,
} from "./people-roster.ts";
import {
  freezeDeclaredWritePlan,
  hasContractFields,
  isFrozenWritePlan,
  isRecord,
  serializeEventEnvelope,
  validateEventEnvelopeIdentity,
  type ActorIdentity,
  type EventEnvelope,
  type FrozenWritePlan,
  type WriteSource,
  type WriteTarget,
} from "./write-chain.contract.ts";

export const PEOPLE_REGISTRY_POLICY_ID = "people-registry/v1";

export interface PeopleDocumentClaim {
  readonly path: typeof PEOPLE_ROSTER_PATH;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: "application/yaml";
  readonly policyId: typeof PEOPLE_REGISTRY_POLICY_ID;
}

export type PeopleEventV1 = EventEnvelope<
  "people-event/v1",
  "people_changed",
  ActorIdentity,
  {
    readonly action: PeopleRosterAction["kind"];
    readonly targetPersonId: string | null;
    readonly roster: PeopleRosterDocumentV1;
    readonly peopleDocumentClaim: PeopleDocumentClaim;
    readonly baseDocumentSha256: string | null;
  }
>;

export interface PeopleEventBundle {
  readonly event: PeopleEventV1;
  readonly plan: FrozenWritePlan<"people_changed">;
  readonly blobs: readonly [
    {
      readonly sha256: string;
      readonly size: number;
      readonly mediaType: "application/yaml";
      readonly body: string;
    },
  ];
}

export interface CompiledPeopleRosterAction extends AppliedPeopleRosterAction {
  readonly bundle: PeopleEventBundle | null;
}

export function compilePeopleRosterActionEvent(input: {
  readonly currentBody: string | null;
  readonly action: PeopleRosterAction;
  readonly eventId: string;
  readonly opId: string;
  readonly workspaceRevision: number;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly occurredAt: string;
}): CompiledPeopleRosterAction {
  const applied = applyPeopleRosterAction(input.currentBody, input.action);
  if (!applied.changed) return { ...applied, bundle: null };
  const claim: PeopleDocumentClaim = {
      path: PEOPLE_ROSTER_PATH,
      sha256: sha256Text(applied.body),
      size: Buffer.byteLength(applied.body),
      mediaType: "application/yaml",
      policyId: PEOPLE_REGISTRY_POLICY_ID,
    },
    event: PeopleEventV1 = {
      schema: "people-event/v1",
      eventId: input.eventId,
      workspaceRevision: input.workspaceRevision,
      opId: input.opId,
      type: "people_changed",
      actor: input.actor,
      source: input.source,
      occurredAt: input.occurredAt,
      payload: {
        action: applied.action,
        targetPersonId: applied.targetPersonId,
        roster: applied.roster,
        peopleDocumentClaim: claim,
        baseDocumentSha256: input.currentBody === null ? null : sha256Text(input.currentBody),
      },
    };
  const errors = validateCurrentPeopleEvent(event);
  if (errors.length) throw new Error(errors.join("; "));
  return {
    ...applied,
    bundle: {
      event,
      plan: peopleEventWritePlan(event),
      blobs: [
        {
          sha256: claim.sha256,
          size: claim.size,
          mediaType: claim.mediaType,
          body: applied.body,
        },
      ],
    },
  };
}

export function validatePeopleEvent(value: unknown): readonly string[] {
  return validatePeopleEventFields(value, true);
}

export function validateCurrentPeopleEvent(value: unknown): readonly string[] {
  return validatePeopleEventFields(value, false);
}

function validatePeopleEventFields(value: unknown, allowUnknownFields: boolean): readonly string[] {
  if (
    !isRecord(value) ||
    !hasContractFields(
      value,
      ["schema", "eventId", "workspaceRevision", "opId", "type", "actor", "source", "occurredAt", "payload"],
      allowUnknownFields,
    ) ||
    value.schema !== "people-event/v1" ||
    value.type !== "people_changed" ||
    !isRecord(value.payload) ||
    !hasContractFields(
      value.payload,
      ["action", "targetPersonId", "roster", "peopleDocumentClaim", "baseDocumentSha256"],
      allowUnknownFields,
    ) ||
    !peopleActions.includes(String(value.payload.action) as PeopleRosterAction["kind"]) ||
    !(value.payload.targetPersonId === null || typeof value.payload.targetPersonId === "string") ||
    !validRoster(value.payload.roster) ||
    !validClaim(value.payload.peopleDocumentClaim, allowUnknownFields) ||
    !(value.payload.baseDocumentSha256 === null || /^[0-9a-f]{64}$/u.test(String(value.payload.baseDocumentSha256)))
  )
    return ["people event envelope or payload is invalid"];
  return validateEventEnvelopeIdentity(value, allowUnknownFields).length
    ? ["people event envelope identity is invalid"]
    : [];
}

const peopleActions: readonly PeopleRosterAction["kind"][] = Object.freeze([
  "people-add",
  "people-set-role",
  "people-remove",
  "people-reconcile",
  "people-replace",
]);

function validRoster(value: unknown): value is PeopleRosterDocumentV1 {
  try {
    const roster = value as PeopleRosterDocumentV1;
    return (
      stableStringify(parsePeopleRosterDocument(serializePeopleRosterDocument(roster))) === stableStringify(roster)
    );
  } catch {
    return false;
  }
}

function validClaim(value: unknown, allowUnknownFields: boolean): boolean {
  return (
    isRecord(value) &&
    hasContractFields(value, ["path", "sha256", "size", "mediaType", "policyId"], allowUnknownFields) &&
    value.path === PEOPLE_ROSTER_PATH &&
    /^[0-9a-f]{64}$/u.test(String(value.sha256)) &&
    Number.isSafeInteger(value.size) &&
    Number(value.size) >= 0 &&
    value.mediaType === "application/yaml" &&
    value.policyId === PEOPLE_REGISTRY_POLICY_ID
  );
}

export function isPeopleEvent(event: { readonly schema: string }): event is PeopleEventV1 {
  return event.schema === "people-event/v1";
}

export function serializePeopleEvent(event: PeopleEventV1): string {
  const errors = validateCurrentPeopleEvent(event);
  if (errors.length) throw new Error(errors.join("; "));
  return serializeEventEnvelope(event);
}

export function peopleEventWritePlan(event: PeopleEventV1): FrozenWritePlan<"people_changed"> {
  const claim = event.payload.peopleDocumentClaim,
    targets: WriteTarget[] = [
      {
        kind: "event_file",
        path: eventObjectTarget(event.opId),
        operation: "create",
      },
      {
        kind: "event_head",
        path: "harness/events/head.json",
        operation: "replace",
      },
      {
        kind: "authored_file",
        path: claim.path,
        operation: "replace",
        sha256: claim.sha256,
        size: claim.size,
        mediaType: claim.mediaType,
      },
      {
        kind: "content_blob",
        sha256: claim.sha256,
        size: claim.size,
        mediaType: claim.mediaType,
      },
      {
        kind: "projection_invalidation",
        projection: "document/v1",
        key: claim.path,
      },
    ];
  if (event.payload.targetPersonId !== null)
    targets.push({
      kind: "projection_invalidation",
      projection: "entity/v1",
      key: `person/${event.payload.targetPersonId}`,
    });
  return freezeDeclaredWritePlan({ commandType: event.type, targets }, ["people_changed"]);
}

export function assertPeopleEventInputs(
  event: PeopleEventV1,
  plan: FrozenWritePlan | undefined,
  blobs: readonly {
    readonly sha256: string;
    readonly size: number;
    readonly mediaType: string;
    readonly body: string;
  }[],
): void {
  assertPeopleEventWritePlan(event, plan);
  const claim = event.payload.peopleDocumentClaim,
    blob = blobs.find((candidate) => candidate.sha256 === claim.sha256);
  if (!blob || blob.size !== claim.size || blob.mediaType !== claim.mediaType || sha256Text(blob.body) !== claim.sha256)
    throw new Error("people.yaml blob must be exact");
  const roster = parsePeopleRosterDocument(blob.body);
  if (stableStringify(roster) !== stableStringify(event.payload.roster))
    throw new Error("people.yaml blob must contain the exact roster snapshot");
}

export function assertPeopleEventWritePlan(event: PeopleEventV1, plan: FrozenWritePlan | undefined): void {
  const shape = (value: FrozenWritePlan) =>
    stableStringify({
      commandType: value.commandType,
      targets: value.targets.map(stableStringify).sort(),
    });
  if (!plan || !isFrozenWritePlan(plan) || shape(plan) !== shape(peopleEventWritePlan(event)))
    throw new Error("people write plan must exactly declare event, people.yaml, content, and projection targets");
}

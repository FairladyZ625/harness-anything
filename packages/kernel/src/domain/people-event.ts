import {
  isRecord,
  validateEventEnvelopeIdentity,
  type ActorIdentity,
  type EventEnvelope,
} from "./write-chain.contract.ts";

/** Retired envelope: accepted history is readable, never admissible as a new write. */
export type RetiredPeopleEventV1 = EventEnvelope<
  "people-event/v1",
  "people_changed",
  ActorIdentity,
  {
    readonly action: string;
    readonly targetPersonId: string | null;
    readonly roster: Readonly<Record<string, unknown>>;
    readonly peopleDocumentClaim: {
      readonly path: "people.yaml";
      readonly sha256: string;
      readonly size: number;
      readonly mediaType: "application/yaml";
      readonly policyId: "people-registry/v1";
    };
    readonly baseDocumentSha256: string | null;
  }
>;

export function validateRetiredPeopleEvent(value: unknown): readonly string[] {
  if (
    !isRecord(value) ||
    value.schema !== "people-event/v1" ||
    value.type !== "people_changed" ||
    !isRecord(value.payload) ||
    typeof value.payload.action !== "string" ||
    !(value.payload.targetPersonId === null || typeof value.payload.targetPersonId === "string") ||
    !isRecord(value.payload.roster) ||
    value.payload.roster.schema !== "harness-people/v1" ||
    !Array.isArray(value.payload.roster.people) ||
    !Array.isArray(value.payload.roster.roles) ||
    !isRecord(value.payload.peopleDocumentClaim)
  )
    return ["retired People audit envelope is invalid"];
  const claim = value.payload.peopleDocumentClaim;
  if (
    claim.path !== "people.yaml" ||
    claim.mediaType !== "application/yaml" ||
    claim.policyId !== "people-registry/v1" ||
    !/^[0-9a-f]{64}$/u.test(String(claim.sha256)) ||
    !Number.isSafeInteger(claim.size) ||
    Number(claim.size) < 0 ||
    !(value.payload.baseDocumentSha256 === null || /^[0-9a-f]{64}$/u.test(String(value.payload.baseDocumentSha256)))
  )
    return ["retired People audit claim is invalid"];
  return validateEventEnvelopeIdentity(value, true);
}

export function isRetiredPeopleEvent(event: { readonly schema: string }): event is RetiredPeopleEventV1 {
  return event.schema === "people-event/v1";
}

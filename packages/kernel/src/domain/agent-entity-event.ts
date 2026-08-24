import { eventObjectTarget } from "../layout/ledger-object-layout.ts";
import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import {
  freezeDeclaredWritePlan,
  hasOnlyFields,
  hasRequiredFields,
  isFrozenWritePlan,
  isRecord,
  validateEventEnvelopeIdentity,
  type ActorIdentity,
  type EventEnvelope,
  type FrozenWritePlan,
  type WriteSource,
  type WriteTarget,
} from "./write-chain.contract.ts";

export const AGENT_ENTITY_DOCUMENT_POLICY_ID = "typed-agent-entity/v1";
export type AgentEntityDeclarationKind = "agent" | "squad";
export interface AgentEntityDeclarationClaim {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: "application/json";
  readonly policyId: typeof AGENT_ENTITY_DOCUMENT_POLICY_ID;
}
export type AgentEntityEventV1 = EventEnvelope<
  "agent-entity-event/v1",
  "agent_entity_written",
  ActorIdentity,
  {
    readonly entityKind: AgentEntityDeclarationKind;
    readonly entityId: string;
    readonly declarationDocumentClaim: AgentEntityDeclarationClaim;
  }
>;
export interface AgentEntityWriteBundle {
  readonly event: AgentEntityEventV1;
  readonly plan: FrozenWritePlan<"AgentEntityWrite">;
  readonly blobs: readonly [
    { readonly sha256: string; readonly size: number; readonly mediaType: "application/json"; readonly body: string },
  ];
}

export function compileAgentEntityWrite(input: {
  readonly entityKind: AgentEntityDeclarationKind;
  readonly entityId: string;
  readonly body: string;
  readonly eventId: string;
  readonly opId: string;
  readonly workspaceRevision: number;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly occurredAt: string;
}): AgentEntityWriteBundle {
  const claim: AgentEntityDeclarationClaim = {
    path: agentEntityDeclarationPath(input.entityKind, input.entityId),
    sha256: sha256Text(input.body),
    size: Buffer.byteLength(input.body),
    mediaType: "application/json",
    policyId: AGENT_ENTITY_DOCUMENT_POLICY_ID,
  };
  const event: AgentEntityEventV1 = {
    schema: "agent-entity-event/v1",
    eventId: input.eventId,
    workspaceRevision: input.workspaceRevision,
    opId: input.opId,
    type: "agent_entity_written",
    actor: input.actor,
    source: input.source,
    occurredAt: input.occurredAt,
    payload: { entityKind: input.entityKind, entityId: input.entityId, declarationDocumentClaim: claim },
  };
  const errors = validateCurrentAgentEntityEvent(event);
  if (errors.length) throw new Error(errors.join("; "));
  return {
    event,
    plan: agentEntityWritePlan(event),
    blobs: [{ sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType, body: input.body }],
  };
}

export function validateAgentEntityEvent(value: unknown): readonly string[] {
  return validateAgentEntityEventFields(value, true);
}
export function validateCurrentAgentEntityEvent(value: unknown): readonly string[] {
  return validateAgentEntityEventFields(value, false);
}
function validateAgentEntityEventFields(value: unknown, allowUnknownFields: boolean): readonly string[] {
  const hasFields = allowUnknownFields ? hasRequiredFields : hasOnlyFields;
  if (
    !isRecord(value) ||
    !hasFields(value, [
      "schema",
      "eventId",
      "workspaceRevision",
      "opId",
      "type",
      "actor",
      "source",
      "occurredAt",
      "payload",
    ]) ||
    value.schema !== "agent-entity-event/v1" ||
    value.type !== "agent_entity_written" ||
    !isRecord(value.payload) ||
    !hasFields(value.payload, ["entityKind", "entityId", "declarationDocumentClaim"])
  )
    return ["agent entity event envelope or payload is invalid"];
  const kind = value.payload.entityKind,
    id = value.payload.entityId,
    claim = value.payload.declarationDocumentClaim;
  if (
    (kind !== "agent" && kind !== "squad") ||
    !entityId(id) ||
    !isRecord(claim) ||
    !hasFields(claim, ["path", "sha256", "size", "mediaType", "policyId"]) ||
    claim.path !== agentEntityDeclarationPath(kind, id) ||
    !/^[0-9a-f]{64}$/u.test(String(claim.sha256)) ||
    !Number.isSafeInteger(claim.size) ||
    (claim.size as number) < 0 ||
    claim.mediaType !== "application/json" ||
    claim.policyId !== AGENT_ENTITY_DOCUMENT_POLICY_ID
  )
    return ["agent entity declaration claim is invalid"];
  return validateEventEnvelopeIdentity(value, allowUnknownFields).length
    ? ["agent entity event identity is invalid"]
    : [];
}

export function isAgentEntityEvent(event: { readonly schema: string }): event is AgentEntityEventV1 {
  return event.schema === "agent-entity-event/v1";
}
export function agentEntityDeclarationPath(kind: AgentEntityDeclarationKind, id: string): string {
  if (!entityId(id)) throw new Error("agent entity id is invalid");
  return normalizeRelativeDocumentPath(`${kind}s/${id}.json`);
}
export function agentEntityWritePlan(event: AgentEntityEventV1): FrozenWritePlan<"AgentEntityWrite"> {
  const claim = event.payload.declarationDocumentClaim,
    targets: WriteTarget[] = [
      { kind: "event_file", path: eventObjectTarget(event.opId), operation: "create" },
      { kind: "event_head", path: "harness/events/head.json", operation: "replace" },
      {
        kind: "authored_file",
        path: claim.path,
        operation: "replace",
        sha256: claim.sha256,
        size: claim.size,
        mediaType: claim.mediaType,
      },
      { kind: "projection_invalidation", projection: "document/v1", key: claim.path },
      { kind: "content_blob", sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType },
    ];
  return freezeDeclaredWritePlan({ commandType: "AgentEntityWrite", targets }, ["AgentEntityWrite"]);
}
export function assertAgentEntityWritePlan(
  event: AgentEntityEventV1,
  plan: FrozenWritePlan<"AgentEntityWrite"> | undefined,
): asserts plan is FrozenWritePlan<"AgentEntityWrite"> {
  const shape = (value: FrozenWritePlan<"AgentEntityWrite">) =>
    stableStringify({ commandType: value.commandType, targets: value.targets.map(stableStringify).sort() });
  if (plan === undefined || !isFrozenWritePlan(plan) || shape(plan) !== shape(agentEntityWritePlan(event)))
    throw new Error("agent entity write plan must exactly declare event, declaration, projection, and content targets");
}
function entityId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value);
}

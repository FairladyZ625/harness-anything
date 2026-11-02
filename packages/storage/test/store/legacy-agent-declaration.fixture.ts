import type { CanonicalEventV1 } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import {
  ownedContentForDeclarationEvent,
  entityUpsertWritePlan,
  type EntityDeclarationClaim,
  type EntityUpsertEventV1,
} from "@harness-anything/kernel/internal/domain/entity-event.ts";
import { requireEntityStoreKindContract } from "@harness-anything/kernel/internal/domain/entity-kind-registry.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
const contract = requireEntityStoreKindContract("agent"),
  actor = { principal: { personId: "person_synthetic" }, executor: null } as const;
/**
 * The migration-window fixture: one installed Agent declaration in the exact shape a
 * pre-runtimes daemon accepted (`runtime_type` string plus top-level `model`). Every current
 * write path validates declarations against today's schema, so the fixture appends the event the
 * way that old daemon did — a raw entity_upserted command (event, claim, blob) written straight
 * to the SQLite ledger under a writer fence, bypassing the bundle validation layer entirely.
 */
export function legacyAgentCommand(opId: string, entityId: string, workspaceRevision: number) {
  const value = {
      schema: "agent-declaration/v1",
      id: entityId,
      name: "Legacy Worker",
      instructions: "Legacy fixture agent.",
      runtime_type: "zcode",
      model: "GLM-5.3",
    },
    body = `${JSON.stringify(value, null, 2)}\n`,
    claim: EntityDeclarationClaim = {
      path: `agents/${entityId}.json`,
      sha256: sha256Text(body),
      size: Buffer.byteLength(body),
      mediaType: contract.entityStore.document.mediaType,
      policyId: contract.entityStore.document.policyId,
    },
    // No ownedContent field yet: ownedContentForDeclarationEvent recovers the accepted
    // pre-manifest shape (exactly one declaration document, nothing else) from the claim.
    event = {
      schema: "entity-event/v1",
      eventId: `event-${opId}`,
      workspaceRevision,
      opId,
      actor,
      source: "local",
      occurredAt: "2026-09-18T00:00:00.000Z",
      type: "entity_upserted",
      payload: { entityKind: "agent", entityId, declarationDocumentClaim: claim },
    } as EntityUpsertEventV1,
    complete: EntityUpsertEventV1 = {
      ...event,
      payload: { ...event.payload, ownedContent: ownedContentForDeclarationEvent(event) },
    };
  return {
    intent: { opId, intentDigest: `sha256:${"a".repeat(64)}`, summary: complete.type },
    events: [complete as unknown as CanonicalEventV1],
    blobs: [{ sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType, body }],
    plan: entityUpsertWritePlan(complete),
  };
}

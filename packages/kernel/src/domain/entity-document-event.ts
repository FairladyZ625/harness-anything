import { sha256Text } from "../integrity/stable-hash.ts";
import { normalizeRelativeDocumentPath } from "../layout/portable-path.ts";
import { eventObjectTarget } from "../layout/ledger-object-layout.ts";
import { codePoints } from "./event-validation.ts";
import { isNonEmptyString } from "./contract-validation.ts";
import { timestamp } from "./timestamp.ts";
import {
  freezeDeclaredWritePlan,
  hasOnlyFields,
  isFrozenWritePlan,
  isRecord,
  sameWriteTargets,
  validateEventEnvelopeIdentity,
  type ActorIdentity,
  type EventEnvelope,
  type FrozenWritePlan,
  type WriteTarget,
  type WriteSource,
} from "./write-chain.contract.ts";

/**
 * A pure current-document refresh: the event carries re-rendered managed document claims for
 * Decision/Fact/Task projections without mutating any business entity row. Appending it through
 * the canonical bundle makes the refreshed bytes durable and replayable; the projection applies
 * only the document upserts, and the follower publishes the authored files at this cut.
 */
export type RematerializedDocumentClaim = {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: "text/markdown" | "application/json";
  readonly policyId: string;
};

export type EntityDocumentEventV1 = EventEnvelope<
  "entity-document-event/v1",
  "entity_documents_rematerialized",
  ActorIdentity,
  {
    readonly rationale: string;
    readonly entityRefs: readonly string[];
    readonly documentClaims: readonly RematerializedDocumentClaim[];
  }
>;

export interface EntityDocumentUpdate {
  readonly path: string;
  readonly body: string;
  readonly mediaType: "text/markdown" | "application/json";
  readonly policyId: string;
}

export interface EntityDocumentRematerializationWrite {
  readonly event: EntityDocumentEventV1;
  readonly plan: FrozenWritePlan;
  readonly blobs: readonly {
    readonly sha256: string;
    readonly size: number;
    readonly mediaType: "text/markdown" | "application/json";
    readonly body: string;
  }[];
}

export function isEntityDocumentEvent(event: { readonly schema: string }): event is EntityDocumentEventV1 {
  return event.schema === "entity-document-event/v1";
}

export function compileEntityDocumentRematerialization(input: {
  readonly entityRefs: readonly string[];
  readonly updates: readonly EntityDocumentUpdate[];
  readonly rationale: string;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly opId: string;
  readonly occurredAt: string;
  readonly workspaceRevision: number;
}): EntityDocumentRematerializationWrite {
  const unique = new Map(input.updates.map((update) => [update.path, update]));
  if (unique.size !== input.updates.length)
    throw new Error("entity document rematerialization updates must have unique paths");
  if (input.updates.length === 0) throw new Error("entity document rematerialization requires one changed document");
  const compiled = [...unique.values()].map((update) => {
      const sha256 = sha256Text(update.body),
        size = Buffer.byteLength(update.body),
        claim: RematerializedDocumentClaim = {
          path: update.path,
          sha256,
          size,
          mediaType: update.mediaType,
          policyId: update.policyId,
        };
      return { claim, blob: { sha256, size, mediaType: update.mediaType, body: update.body } };
    }),
    event: EntityDocumentEventV1 = {
      schema: "entity-document-event/v1",
      eventId: `event-${input.opId}`,
      workspaceRevision: input.workspaceRevision,
      opId: input.opId,
      type: "entity_documents_rematerialized",
      actor: input.actor,
      source: input.source,
      occurredAt: input.occurredAt,
      payload: {
        rationale: input.rationale,
        entityRefs: input.entityRefs,
        documentClaims: compiled.map(({ claim }) => claim),
      },
    };
  const issues = validateCurrentEntityDocumentEvent(event);
  if (issues.length) throw new Error(issues.join("; "));
  return {
    event,
    plan: entityDocumentEventWritePlan(event),
    blobs: [...new Map(compiled.map(({ blob }) => [blob.sha256, blob])).values()],
  };
}

export function entityDocumentEventWritePlan(event: EntityDocumentEventV1): FrozenWritePlan {
  const claims = event.payload.documentClaims,
    targets: WriteTarget[] = [
      { kind: "event_file", path: eventObjectTarget(event.opId), operation: "create" },
      { kind: "event_head", path: "harness/events/head.json", operation: "replace" },
      ...claims.map(
        (claim): WriteTarget => ({
          kind: "authored_file",
          path: claim.path,
          operation: "replace",
          sha256: claim.sha256,
          size: claim.size,
          mediaType: claim.mediaType,
        }),
      ),
      ...[...new Map(claims.map((claim) => [claim.sha256, claim])).values()].map(
        (claim): WriteTarget => ({
          kind: "content_blob",
          sha256: claim.sha256,
          size: claim.size,
          mediaType: claim.mediaType,
        }),
      ),
      ...claims.map(
        (claim): WriteTarget => ({
          kind: "projection_invalidation",
          projection: "document/v1",
          key: claim.path,
        }),
      ),
    ];
  return freezeDeclaredWritePlan({ commandType: event.type, targets }, ["entity_documents_rematerialized"]);
}

export function assertEntityDocumentEventWritePlan(
  event: EntityDocumentEventV1,
  plan: FrozenWritePlan | undefined,
): void {
  const expected = entityDocumentEventWritePlan(event);
  if (
    !plan ||
    !isFrozenWritePlan(plan) ||
    plan.commandType !== expected.commandType ||
    !sameWriteTargets(plan.targets, expected.targets)
  )
    throw new Error(
      "entity document rematerialization plan must exactly declare event, authored documents, blobs, and projections",
    );
}

export function validateEntityDocumentEvent(value: unknown): readonly string[] {
  return validateEntityDocumentEventFields(value, true);
}

export function validateCurrentEntityDocumentEvent(value: unknown): readonly string[] {
  return validateEntityDocumentEventFields(value, false);
}

function validateEntityDocumentEventFields(value: unknown, allowUnknownFields: boolean): readonly string[] {
  const fields = ["schema", "eventId", "workspaceRevision", "opId", "type", "actor", "source", "occurredAt", "payload"];
  if (
    !isRecord(value) ||
    !(allowUnknownFields ? fields.every((field) => Object.hasOwn(value, field)) : hasOnlyFields(value, fields)) ||
    value.schema !== "entity-document-event/v1" ||
    value.type !== "entity_documents_rematerialized" ||
    !timestamp(value.occurredAt) ||
    validateEventEnvelopeIdentity(value, allowUnknownFields).length > 0 ||
    !isRecord(value.payload)
  )
    return ["entity document event envelope is invalid"];
  const payload = value.payload;
  if (
    !(allowUnknownFields
      ? ["rationale", "entityRefs", "documentClaims"].every((field) => Object.hasOwn(payload, field))
      : hasOnlyFields(payload, ["rationale", "entityRefs", "documentClaims"]))
  )
    return ["entity document event envelope is invalid"];
  if (
    !codePoints(payload.rationale, 1, 400) ||
    !Array.isArray(payload.entityRefs) ||
    payload.entityRefs.length === 0 ||
    new Set(payload.entityRefs).size !== payload.entityRefs.length ||
    payload.entityRefs.some((ref) => !isNonEmptyString(ref) || !/^[^\s/]+\/[^\s/]+$/u.test(ref)) ||
    !validDocumentClaims(payload.documentClaims, allowUnknownFields)
  )
    return ["entity document event payload is invalid"];
  return [];
}

function validDocumentClaims(
  value: unknown,
  allowUnknownFields: boolean,
): value is readonly RematerializedDocumentClaim[] {
  const claimFields = ["path", "sha256", "size", "mediaType", "policyId"];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    new Set(value.map((claim) => (isRecord(claim) ? claim.path : null))).size !== value.length
  )
    return false;
  return value.every((claim) => {
    if (
      !isRecord(claim) ||
      !(allowUnknownFields
        ? claimFields.every((field) => Object.hasOwn(claim, field))
        : hasOnlyFields(claim, claimFields)) ||
      typeof claim.path !== "string" ||
      !/^[0-9a-f]{64}$/u.test(String(claim.sha256)) ||
      !Number.isSafeInteger(claim.size) ||
      (claim.size as number) <= 0 ||
      !["text/markdown", "application/json"].includes(String(claim.mediaType)) ||
      !isNonEmptyString(claim.policyId)
    )
      return false;
    try {
      return normalizeRelativeDocumentPath(claim.path) === claim.path;
    } catch {
      return false;
    }
  });
}

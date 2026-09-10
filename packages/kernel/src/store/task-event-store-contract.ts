import { serializePersistedCanonicalEvent, type CanonicalEventV1 } from "../domain/doc-sync.contract.ts";
import {
  freezeDeclaredWritePlan,
  serializeEventHead,
  type EventHead,
  type FrozenWritePlan,
  type LedgerCutIdentity,
} from "../domain/write-chain.contract.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { eventObjectTarget } from "../layout/ledger-object-layout.ts";
import type { CanonicalEventCut, CanonicalWriteBundle } from "./task-event-store-types.ts";
import { assertBundle } from "./task-event-store-validation.ts";
import { contentClaims } from "./task-event-store-claims-layout.ts";

// Public bundle validation and canonical declared-write-plan construction.
export function validateCanonicalWriteBundle(bundle: CanonicalWriteBundle): void {
  assertBundle(bundle);
  for (const preceding of bundle.preceding ?? []) assertBundle(preceding);
}
export function canonicalEventContentClaims(event: CanonicalEventV1): readonly {
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
}[] {
  return contentClaims(event);
}
export function canonicalEventWritePlan(event: CanonicalEventV1, projection: string, key: string): FrozenWritePlan {
  return freezeDeclaredWritePlan(
    {
      commandType: event.type,
      targets: [
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
        ...contentClaims(event).map((claim) => ({
          kind: "content_blob" as const,
          sha256: claim.sha256,
          size: claim.size,
          mediaType: claim.mediaType,
        })),
        { kind: "projection_invalidation", projection, key },
      ],
    },
    [event.type],
  );
}
export function canonicalEventCut(repoId: string, event: CanonicalEventV1): CanonicalEventCut {
  return canonicalEventCutFromHead(repoId, {
    revision: event.workspaceRevision,
    opId: event.opId,
    eventDigest: `sha256:${sha256Text(serializePersistedCanonicalEvent(event))}`,
  });
}
/** Same identity as `canonicalEventCut`, from an event digest the store already has on hand. */
export function canonicalEventCutFromHead(repoId: string, head: EventHead): CanonicalEventCut {
  return {
    repoId,
    revision: head.revision,
    opId: head.opId,
    headDigest: `sha256:${sha256Text(serializeEventHead(head))}`,
  };
}
export function canonicalLedgerCut(repoId: string, head: EventHead | null): LedgerCutIdentity {
  return {
    repoId,
    revision: head?.revision ?? 0,
    headDigest: `sha256:${sha256Text(head === null ? "null\n" : serializeEventHead(head))}`,
  };
}

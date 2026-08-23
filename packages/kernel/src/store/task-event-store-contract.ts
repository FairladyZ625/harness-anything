import { type CanonicalEventV1 } from "../domain/doc-sync.contract.ts";
import { freezeDeclaredWritePlan, type FrozenWritePlan } from "../domain/write-chain.contract.ts";
import { eventObjectTarget } from "../layout/ledger-object-layout.ts";
import type { CanonicalWriteBundle } from "./task-event-store-types.ts";
import { assertBundle } from "./task-event-store-validation.ts";
import { contentClaims } from "./task-event-store-claims-layout.ts";

// Public bundle validation and canonical declared-write-plan construction.
export function validateCanonicalWriteBundle(bundle: CanonicalWriteBundle): void {
  assertBundle(bundle);
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

import { serializePersistedCanonicalEvent, type CanonicalEventV1 } from "../domain/doc-sync.contract.ts";
import { type CanonicalEventV1 as CanonicalEventRecord } from "../domain/doc-sync-types.ts";
import { storageReadPolicy } from "../domain/storage-read-policy.ts";
import {
  freezeDeclaredWritePlan,
  serializeEventHead,
  type EventHead,
  type FrozenWritePlan,
  type LedgerCutIdentity,
} from "../domain/write-chain.contract.ts";
import { sha256Text } from "../integrity/stable-hash.ts";
import { eventObjectTarget } from "../layout/ledger-object-layout.ts";
import type { CanonicalEventCut, CanonicalEventStore, CanonicalWriteBundle } from "./task-event-store.ts";
import { assertBundle } from "./canonical-event-validation.ts";
import { contentClaims } from "./canonical-document-claims.ts";

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

export const DEFAULT_EVENT_LIST_LIMIT = storageReadPolicy.defaultValue.listDefaults.eventLimit;
export const EVENT_LIST_LIMIT_MAX = storageReadPolicy.defaultValue.pageSizes.standard;

export type EventSliceFilter = {
  readonly eventType?: CanonicalEventRecord["type"];
  readonly entity?: string;
  readonly actor?: string;
};

function forEachQueryEventPage(
  store: { readonly queryEvents?: CanonicalEventStore["queryEvents"] },
  filter: EventSliceFilter,
  pageSize: number,
  onPage: (page: readonly CanonicalEventRecord[]) => boolean | void,
): void {
  const queryEvents = store.queryEvents;
  if (!queryEvents) {
    throw new Error("CanonicalEventStore.queryEvents is required for bounded event queries.");
  }
  let revisionBound: number | undefined;
  for (;;) {
    const page = queryEvents({
      ...(filter.eventType === undefined ? {} : { type: filter.eventType }),
      ...(filter.entity === undefined ? {} : { entity: filter.entity }),
      ...(filter.actor === undefined ? {} : { actor: filter.actor }),
      ...(revisionBound === undefined ? {} : { revisionBound }),
      limit: pageSize,
    });
    if (onPage(page) === false || page.length < pageSize) return;
    const nextBound = page[page.length - 1]!.workspaceRevision;
    if (revisionBound !== undefined && nextBound >= revisionBound) return;
    revisionBound = nextBound;
  }
}

/**
 * Scan indexed `queryEvents` pages backwards until `predicate` matches or history ends.
 */
export function someQueryEvent(
  store: { readonly queryEvents?: CanonicalEventStore["queryEvents"] },
  filter: EventSliceFilter,
  predicate: (event: CanonicalEventRecord) => boolean,
  pageSize = EVENT_LIST_LIMIT_MAX,
): boolean {
  let matched = false;
  forEachQueryEventPage(store, filter, pageSize, (page) => {
    if (page.some(predicate)) {
      matched = true;
      return false;
    }
  });
  return matched;
}

/**
 * Collect matching events across bounded `queryEvents` pages in ascending `workspaceRevision` order.
 */
export function collectQueryEvents(
  store: { readonly queryEvents?: CanonicalEventStore["queryEvents"] },
  filters: readonly EventSliceFilter[],
  pageSize = EVENT_LIST_LIMIT_MAX,
): CanonicalEventRecord[] {
  const collected: CanonicalEventRecord[] = [];
  for (const filter of filters) {
    forEachQueryEventPage(store, filter, pageSize, (page) => {
      collected.push(...page);
    });
  }
  return collected.sort((left, right) => left.workspaceRevision - right.workspaceRevision);
}

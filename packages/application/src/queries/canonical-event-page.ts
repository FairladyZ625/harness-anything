import {
  CANONICAL_EVENT_PAGE_SCHEMA,
  CanonicalEventReadError,
  type CanonicalEventPage,
  type CanonicalEventReadRequest,
  type CanonicalEventStore,
} from "@harness-anything/kernel";

/** Replay the same bounded, committed canonical batch used for projection catch-up. */
export function readCanonicalEventPage(
  store: Pick<CanonicalEventStore, "readBatch">,
  repoId: string,
  { afterRevision, limit }: CanonicalEventReadRequest,
): CanonicalEventPage {
  const { events, sourceRevision: headRevision, done } = store.readBatch(String(afterRevision), limit);
  if (afterRevision > headRevision)
    throw new CanonicalEventReadError(
      "invalid_cursor",
      `Canonical event cursor ${afterRevision} is ahead of head revision ${headRevision}.`,
    );
  return {
    schema: CANONICAL_EVENT_PAGE_SCHEMA,
    ok: true,
    repoId,
    events,
    headRevision,
    nextAfterRevision: events.at(-1)?.workspaceRevision ?? afterRevision,
    hasMore: !done,
  };
}

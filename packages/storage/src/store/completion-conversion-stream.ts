import type { SqliteEventStore } from "./sqlite-event-store.ts";
import type { PersistedCanonicalEventV1 } from "@harness-anything/kernel";
import { contentClaims } from "@harness-anything/kernel/internal/ports/canonical-document-claims.ts";
export function completionConversionStream(source: SqliteEventStore) {
  return {
    readHead: () => source.eventIdentityAtRevision(source.revision()),
    readContentBlob: source.readContentObject,
    readBatch(cursor: string | null, maxItems: number) {
      const page = source.eventRowPage(Number(cursor ?? 0), maxItems);
      return {
        sourceRevision: source.revision(),
        events: page.rows.map((row) => JSON.parse(row.eventJson) as PersistedCanonicalEventV1),
        cursor: page.done ? null : String(page.rows.at(-1)!.revision),
        done: page.done,
        accessedItems: page.rows.length,
        prefetchContent: (events: readonly PersistedCanonicalEventV1[]) =>
          new Map(
            events.flatMap((event) =>
              contentClaims(event).map((claim) => [claim.sha256, source.readContentObject(claim.sha256)] as const),
            ),
          ),
      };
    },
  };
}

import path from "node:path";
import type { CanonicalEventStore } from "./task-event-store-types.ts";
import { CANONICAL_EVENT_REF, TaskEventStoreError } from "./task-event-store-types.ts";
import { createStoreRuntime, type StoreRuntime } from "./task-event-store-runtime.ts";
import { createPublicationApi } from "./task-event-store-publication.ts";
import {
  canonicalEventCut,
  canonicalLedgerCut,
  canonicalRevisionAt,
  readBatch,
  readStream,
} from "./task-event-store-reads.ts";
import { cachedBatchEventEntries, scanEventsRoot } from "./task-event-store-layout.ts";
import { materialize } from "./task-event-store-materialization.ts";

// Public event-store factory that composes runtime state, reading, and publication roles.
export function makeTaskEventStore(options: Parameters<typeof createStoreRuntime>[0]): CanonicalEventStore {
  const runtime = createStoreRuntime(options),
    publication = createPublicationApi(runtime);
  return storeApi(runtime, publication);
}
function storeApi(runtime: StoreRuntime, publication: ReturnType<typeof createPublicationApi>): CanonicalEventStore {
  return {
    canonicalRef: CANONICAL_EVENT_REF,
    currentCommit: runtime.currentCommit,
    currentCut: () => canonicalLedgerCut(runtime.repoId, runtime.readHead()),
    publication: (event) => ({
      commitSha: runtime.currentCommit(),
      cut: canonicalEventCut(runtime.repoId, event),
    }),
    readHead: runtime.readHead,
    readEvent: runtime.readEvent,
    readTaskEvent: runtime.readTaskEvent,
    readContentBlob: runtime.readContentBlob,
    layout: () => {
      if (runtime.layoutState === undefined) {
        const scan = scanEventsRoot(runtime.ledger, runtime.canonicalCommit);
        runtime.layoutState =
          scan !== null && scan.flat.length > 0
            ? scan.shards.length > 0
              ? "mixed"
              : "flat/v1"
            : "sharded-sha256-2/v1";
      }
      return runtime.layoutState;
    },
    revisionAt: (commit) => {
      if (commit.repoId !== runtime.repoId)
        throw new TaskEventStoreError(
          "repo_mismatch",
          `ledger commit belongs to repo ${commit.repoId}, not ${runtime.repoId}`,
        );
      return canonicalRevisionAt(runtime.ledger, runtime.canonicalCommit, commit.sha);
    },
    read: () => {
      const stream = readStream(runtime.ledger, runtime.canonicalCommit, runtime.readHead());
      runtime.knownOpIds = new Set(stream.events.map((event) => event.opId));
      runtime.rememberEvents(stream.events);
      return stream;
    },
    readBatch: (cursor, maxItems) => {
      const batch = readBatch(runtime.ledger, runtime.canonicalCommit, runtime.readHead(), cursor, maxItems);
      runtime.knownOpIds = new Set(
        cachedBatchEventEntries(runtime.ledger, runtime.canonicalCommit).map((entry) =>
          path.posix.basename(entry.name).slice(0, -5),
        ),
      );
      runtime.rememberEvents(batch.events);
      return batch;
    },
    materialize: () =>
      materialize(runtime.ledger, runtime.repoId, runtime.canonicalCommit, runtime.readHead(), runtime.authoredRef),
    append: (bundle) => publication.publish(bundle),
    migrateLayout: publication.migrateLayout,
    recover: publication.recover,
    drain: async () => {},
  };
}

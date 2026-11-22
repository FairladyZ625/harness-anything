import assert from "node:assert/strict";
import { join } from "node:path";
import type { InboxRead } from "@harness-anything/kernel/internal/domain/inbox.ts";
import { makeTaskProjection } from "../src/projection/rebuildable-task-projection.ts";
import { makeTaskEventStore } from "../src/store/task-event-store.ts";
import { inboxBundle, inboxParityQueries, inboxScenario } from "./store/inbox-events.fixture.ts";

type BackendStorage = NonNullable<Parameters<typeof makeTaskEventStore>[0]["storage"]>;

/**
 * (e) Append the same Inbox scenario to a PostgreSQL-family backend and to SQLite, then require every read
 * shape to answer identically. Returns the backend's reads for follow-up refold checks.
 */
export async function assertInboxBackendParity(input: {
  readonly rootDir: string;
  readonly repoId: string;
  readonly storage: BackendStorage;
}): Promise<readonly InboxRead[]> {
  const backendStore = makeTaskEventStore({ repoId: input.repoId, rootDir: input.rootDir, storage: input.storage }),
    backendProjection = makeTaskProjection({
      rootDir: input.rootDir,
      eventStore: backendStore,
      storage: input.storage,
    }),
    sqliteRoot = join(input.rootDir, "sqlite-parity"),
    sqliteStore = makeTaskEventStore({ repoId: input.repoId, rootDir: sqliteRoot }),
    sqliteProjection = makeTaskProjection({ rootDir: sqliteRoot, eventStore: sqliteStore });
  try {
    for (const event of inboxScenario()) {
      backendStore.append(inboxBundle(event));
      sqliteStore.append(inboxBundle(event));
      sqliteProjection.apply(event);
    }
    const backendReads = inboxParityQueries.map((query) => backendProjection.readInbox(query));
    assert.deepEqual(
      backendReads,
      inboxParityQueries.map((query) => sqliteProjection.readInbox(query)),
    );
    const pending = backendReads[0]!;
    assert.equal(pending.status, "ready");
    assert.deepEqual(pending.status === "ready" ? pending.items.map(({ itemId }) => itemId) : [], [
      "item-a2",
      "item-c1",
    ]);
    return backendReads;
  } finally {
    sqliteProjection.close();
    await sqliteStore.drain();
    backendProjection.close();
    await backendStore.drain();
  }
}

/** Reopen the backend and require the (re)folded Inbox model to answer the recorded reads. */
export async function assertInboxReopenedReads(input: {
  readonly rootDir: string;
  readonly repoId: string;
  readonly storage: BackendStorage;
  readonly expected: readonly InboxRead[];
}): Promise<void> {
  const store = makeTaskEventStore({ repoId: input.repoId, rootDir: input.rootDir, storage: input.storage }),
    projection = makeTaskProjection({ rootDir: input.rootDir, eventStore: store, storage: input.storage });
  try {
    assert.deepEqual(
      inboxParityQueries.map((query) => projection.readInbox(query)),
      input.expected,
    );
  } finally {
    projection.close();
    await store.drain();
  }
}

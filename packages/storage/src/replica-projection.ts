import { openSqliteEventStore } from "./store/sqlite-event-store.ts";
import { sqliteEventBatch } from "./store/sqlite-task-event-store.ts";
import { makeTaskProjection } from "./projection/rebuildable-task-projection.ts";

/** Transport generations have explicit paths and never inherit a surrounding repository layout. */
export function openReplicaProjection(input: {
  readonly repoId: string;
  readonly rootDir: string;
  readonly ledgerPath: string;
  readonly projectionPath: string;
  readonly generation: number;
  /**
   * Optional sizes for `fleet-basebackup/v4` deferred cold raw artifacts during initial PG seed hydration.
   * Only satisfied for `raw-artifact/v1` projection sizing; no bytes are persisted to disk or DB.
   */
  readonly deferredColdBlobSizes?: ReadonlyMap<string, number>;
}) {
  const reader = openSqliteEventStore({
    repoId: input.repoId,
    databasePath: input.ledgerPath,
    generation: input.generation,
    readOnly: true,
  });
  try {
    const readContentBlob = (sha256: string): Uint8Array | null => {
      const local = reader.readContentObject(sha256);
      if (local !== null) return local;
      const deferredSize = input.deferredColdBlobSizes?.get(sha256);
      return deferredSize !== undefined ? new Uint8Array(deferredSize) : null;
    };
    const events = {
        readHead: () => reader.eventIdentityAtRevision(reader.revision()),
        readBatch: (cursor: string | null, size: number) => sqliteEventBatch(reader, cursor, size, readContentBlob),
        readContentBlob,
      },
      projection = makeTaskProjection({
        rootDir: input.rootDir,
        eventStore: events,
        projectionPath: input.projectionPath,
      });
    return {
      projection,
      close: () => {
        projection.close();
        reader.close();
      },
    };
  } catch (error) {
    reader.close();
    throw error;
  }
}

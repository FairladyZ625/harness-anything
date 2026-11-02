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
}) {
  const reader = openSqliteEventStore({
    repoId: input.repoId,
    databasePath: input.ledgerPath,
    generation: input.generation,
    readOnly: true,
  });
  try {
    const events = {
        readHead: () => reader.eventIdentityAtRevision(reader.revision()),
        readBatch: (cursor: string | null, size: number) =>
          sqliteEventBatch(reader, cursor, size, reader.readContentObject),
        readContentBlob: reader.readContentObject,
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

import { makeSqliteTaskEventStore, type SqliteTaskEventStoreOptions } from "./sqlite-task-event-store.ts";
import { activateEmptyCanonicalGeneration, resolveActiveGeneration } from "./sqlite-event-store.ts";

// Ordinary attachment cannot bypass activation with an explicit old generation.
// Offline conversion opens its source through the read-only SQLite storage port.
const selectGeneration = (options: SqliteTaskEventStoreOptions): SqliteTaskEventStoreOptions => {
  const rootInput = options.rootInput ?? options.rootDir;
  if (options.generation !== undefined && options.generation !== 3)
    throw new Error("ordinary readers and writers require generation 3; old generations are offline inputs");
  if (rootInput === undefined) return options;
  return { ...options, generation: resolveActiveGeneration({ rootInput, repoId: options.repoId }) };
};

export const makeTaskEventStore = (options: SqliteTaskEventStoreOptions) => {
  const selected = selectGeneration(options);
  return makeSqliteTaskEventStore({
    ...selected,
    ...(options.activationPreflight === undefined && selected.generation === 3
      ? { activationPreflight: activateEmptyCanonicalGeneration }
      : {}),
  });
};
export const makeTaskEventReader = (options: SqliteTaskEventStoreOptions) =>
  makeSqliteTaskEventStore({ ...selectGeneration(options), mutable: false });
export type { SqliteCanonicalEventStore, SqliteTaskEventStoreOptions } from "./sqlite-task-event-store.ts";
export { readCertifiedGitFollower, type CertifiedGitFollower } from "./sqlite-task-event-publication.ts";

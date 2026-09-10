import { makeSqliteTaskEventStore, type SqliteTaskEventStoreOptions } from "./sqlite-task-event-store.ts";
import { activateEmptyCanonicalGeneration, resolveActiveGeneration } from "./sqlite-event-store.ts";

// Writers and readers must land on the same generation, or a restart would read a ledger nobody
// is writing. An explicit generation always wins so an operator can still audit the retained one.
const selectGeneration = (options: SqliteTaskEventStoreOptions): SqliteTaskEventStoreOptions => {
  const rootInput = options.rootInput ?? options.rootDir;
  if (options.generation !== undefined || rootInput === undefined) return options;
  return { ...options, generation: resolveActiveGeneration({ rootInput, repoId: options.repoId }) };
};

export const makeTaskEventStore = (options: SqliteTaskEventStoreOptions) => {
  const selected = selectGeneration(options);
  return makeSqliteTaskEventStore({
    ...selected,
    ...(options.activationPreflight === undefined && selected.generation === 2
      ? { activationPreflight: activateEmptyCanonicalGeneration }
      : {}),
  });
};
export const makeTaskEventReader = (options: SqliteTaskEventStoreOptions) =>
  makeSqliteTaskEventStore({ ...selectGeneration(options), mutable: false });
export type { SqliteCanonicalEventStore, SqliteTaskEventStoreOptions } from "./sqlite-task-event-store.ts";
export { readCertifiedGitFollower, type CertifiedGitFollower } from "./sqlite-task-event-store.ts";

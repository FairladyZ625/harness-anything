import { makeSqliteTaskEventStore, type SqliteTaskEventStoreOptions } from "./sqlite-task-event-store.ts";

export const makeTaskEventStore = makeSqliteTaskEventStore;
export const makeTaskEventReader = (options: SqliteTaskEventStoreOptions) =>
  makeSqliteTaskEventStore({ ...options, mutable: false });
export type { SqliteCanonicalEventStore, SqliteTaskEventStoreOptions } from "./sqlite-task-event-store.ts";

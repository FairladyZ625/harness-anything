// Version 15 discards caches whose task_snapshot table inferred missing pinned
// values as false. CREATE TABLE IF NOT EXISTS cannot replace that generated column.
// A version mismatch takes the discard-and-replay path; explicit rebuild uses
// the same cold path so it also repairs a cache whose version metadata is wrong.
export const taskProjectionSchemaVersion = 15;

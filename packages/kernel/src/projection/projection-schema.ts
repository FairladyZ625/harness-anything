// Version 14 discards caches whose fact/fact_fts tables predate first-class,
// optionally taskless Facts. CREATE TABLE IF NOT EXISTS cannot migrate that DDL.
// A version mismatch takes the discard-and-replay path; explicit rebuild uses
// the same cold path so it also repairs a cache whose version metadata is wrong.
export const taskProjectionSchemaVersion = 14;

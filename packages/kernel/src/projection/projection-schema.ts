// Version 17 normalizes every stored snapshot.task through currentTaskForWrite so
// legacy hosted fields (relations, metadata.longRunning) embedded in event payloads
// never reach GUI-facing task rows. A version mismatch takes the discard-and-replay
// path so caches written by older appliers are rebuilt with normalized rows.
export const taskProjectionSchemaVersion = 17;

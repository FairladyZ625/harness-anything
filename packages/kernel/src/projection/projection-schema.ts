// Version 20 indexes task_relation by task_id and keys decision_fts rows by the decision rowid,
// so a Task or Decision event no longer scans those tables. A mismatch discards and replays the
// rebuildable cache.
export const taskProjectionSchemaVersion = 20;

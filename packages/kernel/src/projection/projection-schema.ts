// Version 20 indexes task_relation by task_id and keys decision_fts rows by the decision rowid,
// so a Task or Decision event no longer scans those tables. A mismatch discards and replays the
// rebuildable cache. Version 23 adds pinned_entities, which the replay fills from historical task pins.
// Version 24 replays Settings snapshots into the symmetric roles matrix.
export const taskProjectionSchemaVersion = 24;

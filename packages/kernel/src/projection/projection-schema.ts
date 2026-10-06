// Version 20 indexes task_relation by task_id and keys decision_fts rows by the decision rowid,
// so a Task or Decision event no longer scans those tables. A mismatch discards and replays the
// rebuildable cache. Version 23 adds pinned_entities, which the replay fills from historical task pins.
// Version 24 replays Settings snapshots into the symmetric roles matrix.
// Version 25 rebuilds Schedule run views without retired assignment authority evidence.
// Version 26 retains canonical retired People audit documents in replica manifests without restoring authority.
// Version 27 replays entity owned documents and retirements into the canonical document read model.
// Version 28 stores each relation_edge's own updated_at instead of joining event_index for it, so the
// same relation page query runs unchanged on an edge replica that carries no event rows.
export const taskProjectionSchemaVersion = 28;

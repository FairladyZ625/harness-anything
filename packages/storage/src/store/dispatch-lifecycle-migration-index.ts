import type { DatabaseSync } from "node:sqlite";

/** Legacy sessions with no accepted stop proof; outcomes do not prove process-tree stop. */
export function legacyDispatchLifecycleMigrationSessions(db: DatabaseSync): readonly string[] {
  return db
    .prepare(
      "SELECT runtime_session_id FROM runtime_session WHERE " +
        "NOT EXISTS (SELECT 1 FROM dispatch_lifecycle_attempt AS lifecycle " +
        "WHERE lifecycle.runtime_session_id = runtime_session.runtime_session_id " +
        "AND json_extract(lifecycle.attempt_json, '$.stopProof') = 'proven_stopped' " +
        "AND json_extract(lifecycle.attempt_json, '$.capacity') = 'released') " +
        "ORDER BY runtime_session_id",
    )
    .all()
    .map((row) => String(row.runtime_session_id));
}

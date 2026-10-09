// Shared transport fixtures exercise the private serializer without widening the production barrel.
export { edgeReadModelEntries } from "../../src/projection/read-model.ts";
export type { ReplicaProjectionBasis } from "../../src/projection/task-projection-port.ts";
export type { ReplicaChange } from "../../src/projection/replica-sequence.ts";

import type { DatabaseSync } from "node:sqlite";
import {
  createReplicaSequence,
  initializeReplicaSequenceConnection,
  recordReplicaRevision,
  readReplicaSequence,
} from "../../src/projection/replica-sequence.ts";
import type { PersistedCanonicalEventV1 } from "../../src/domain/doc-sync.contract.ts";

/** Direct-SQL repository-family fixtures still publish through the canonical sequence serializer. */
export function replicaModelFixtureSnapshot(db: DatabaseSync, head: PersistedCanonicalEventV1) {
  const events = db
    .prepare("SELECT event_json FROM event_index ORDER BY workspace_revision")
    .all()
    .map((row) => JSON.parse(String(row.event_json)) as PersistedCanonicalEventV1);
  createReplicaSequence(db);
  initializeReplicaSequenceConnection(db);
  db.exec(
    "DELETE FROM replica_revision; DELETE FROM replica_entry; DELETE FROM replica_change; DELETE FROM replica_dirty;",
  );
  let revision = 1;
  // These query fixtures seed final rows directly, not a replayable event stream.
  // Initial serialization reads those rows; events supply only their content sidecars.
  const capture = (event: PersistedCanonicalEventV1) => recordReplicaRevision(db, event, JSON.stringify(event), 0);
  capture({ ...head, workspaceRevision: revision });
  for (const event of events) {
    // The fixture already seeded the final rows. Re-touch the owning session just as its reducer does.
    if (event.schema === "agent-runtime-event/v1" && event.type === "runtime_session_outcome_observed")
      db.prepare("UPDATE runtime_session SET value_json=value_json WHERE runtime_session_id=?").run(
        event.payload.runtimeSessionId,
      );
    if (event.schema === "schedule-event/v1") db.exec("UPDATE runtime_session SET value_json=value_json");
    capture({ ...event, workspaceRevision: ++revision });
  }
  capture(head);
  return readReplicaSequence(db, null)!.changes;
}

export type { EdgeReadModelRows } from "../../src/projection/read-model.ts";

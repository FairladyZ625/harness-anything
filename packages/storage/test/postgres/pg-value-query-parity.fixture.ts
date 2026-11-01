import assert from "node:assert/strict";
import type { TaskProjectionQueries } from "@harness-anything/kernel";
import type { PgTaskQueryMethods } from "../../src/pg/pg-task-query-contract.ts";

type ValueQueries = Pick<
  TaskProjectionQueries,
  | "listEntities"
  | "getEntity"
  | "listPinnedEntities"
  | "readRuntimeInstallation"
  | "readRuntimeInstallations"
  | "readRuntimeSession"
  | "readRuntimeSessions"
  | "readRuntimeSessionsForTask"
  | "readRuntimeSessionPage"
  | "readSquadRun"
  | "readSquadRuns"
  | "readLeaseIntervals"
  | "readDocument"
  | "readDocuments"
  | "readReplicaBasis"
  | "taskIdForDocumentPath"
  | "readArtifactEntityState"
  | "readPresetSnapshot"
  | "readTaskIdsForTaskContractMigration"
>;
function valueContract(queries: ValueQueries) {
  assert.equal(queries.getEntity("agent", "missing"), null);
  assert.equal(queries.readDocument("missing").document, null);
  assert.equal(queries.readRuntimeSession("missing"), null);
  assert.ok(queries.readRuntimeSession("runtime-query-session"));
  assert.ok(queries.readRuntimeInstallation("runtime-query-installation"));
  assert.throws(() => queries.readRuntimeSessionPage({ limit: 0 }), /limit/);
  assert.throws(() => queries.readRuntimeSessionPage({ limit: 65 }), /limit/);
  assert.throws(() => queries.readReplicaBasis(-1), /revision/);
  const documents = queries.readDocuments("");
  const bootstrap = queries.readReplicaBasis(0).events.find((event) => event.schema === "task-bootstrap-event/v1");
  assert.ok(bootstrap && bootstrap.schema === "task-bootstrap-event/v1");
  const preset = queries.readPresetSnapshot(bootstrap.payload.presetSnapshotClaim.digest);
  assert.ok(preset.snapshot);
  const run = queries.readSquadRun("squad_aaaaaaaaaaaaaaaaaaaaaaaa");
  assert.ok(run);
  assert.equal(run.state.ownerDispatchId, "runtime-query-a");
  assert.ok(documents.documents.length > 1);
  const pinned = queries.listPinnedEntities();
  assert.deepEqual(
    pinned.map(({ entityRef }) => entityRef),
    ["fact/F-11111111", "task/task-parity", "task/task-bootstrap-projection"],
  );
  const entities = ["agent", "squad", "execution", "review", "runtime-session", "settings", "missing"].map((kind) => ({
    kind,
    rows: queries.listEntities(kind),
  }));
  return {
    entities,
    singleEntities: entities.flatMap(({ kind, rows }) => rows.map(({ id }) => queries.getEntity(kind, id))),
    pinned,
    installation: queries.readRuntimeInstallation("runtime-query-installation"),
    installations: queries.readRuntimeInstallations(),
    session: queries.readRuntimeSession("runtime-query-session"),
    sessions: queries.readRuntimeSessions(),
    sessionsForTask: queries.readRuntimeSessionsForTask("task-parity"),
    emptySessions: queries.readRuntimeSessionsForTask("missing"),
    page: queries.readRuntimeSessionPage({ limit: 1 }),
    scopedPage: queries.readRuntimeSessionPage({ limit: 1, taskId: "task-parity" }),
    emptyPage: queries.readRuntimeSessionPage({ limit: 1, afterRuntimeSessionId: "zzz" }),
    run,
    missingRun: queries.readSquadRun("missing"),
    runs: queries.readSquadRuns(),
    intervals: queries.readTaskIdsForTaskContractMigration().map((id) => queries.readLeaseIntervals(id)),
    artifacts: ["replay-agent", "deleted-agent", "retired-agent", "missing"].map((id) =>
      queries.readArtifactEntityState("agent", id),
    ),
    documents,
    prefix: queries.readDocuments("tasks/task-parity-fixture/"),
    documentRows: documents.documents.map(({ path }) => queries.readDocument(path)),
    replica: [queries.readReplicaBasis(null), queries.readReplicaBasis(0), queries.readReplicaBasis(1_000_000)],
    owners: documents.documents.map(({ path }) => queries.taskIdForDocumentPath(path)),
    missingOwner: queries.taskIdForDocumentPath("tasks/task-parity-fixture-other/progress.md"),
    preset,
    missingPreset: queries.readPresetSnapshot("missing"),
  };
}
export function assertValueQueryParity(pg: PgTaskQueryMethods, sqlite: TaskProjectionQueries): void {
  assert.deepEqual(valueContract(pg), valueContract(sqlite));
}

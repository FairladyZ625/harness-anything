import assert from "node:assert/strict";
import type { TaskProjectionQueries } from "@harness-anything/kernel";
import type { PgTaskQueryMethods } from "../../src/pg/pg-task-query-contract.ts";

type ValueQueries = Pick<
  TaskProjectionQueries,
  | "listEntities"
  | "countEntities"
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
  | "readLatestLeaseIntervalForExecution"
  | "readLatestLeaseInterval"
  | "readDecisions"
  | "readDecision"
  | "readDocumentMetadata"
  | "readDocument"
  | "readDocuments"
  | "readArtifactTimelinePage"
  | "readReplicaBasis"
  | "taskIdForDocumentPath"
  | "readArtifactEntityState"
  | "readPresetSnapshot"
  | "readTaskIdsForTaskContractMigration"
>;
function valueContract(queries: ValueQueries) {
  assert.equal(queries.getEntity("agent", "missing"), null);
  assert.equal(queries.readDocument("missing").document, null);
  assert.equal(queries.readDocumentMetadata("missing").document, null);
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
  const artifactPage = queries.readArtifactTimelinePage({ kind: "md", limit: 2 }),
    artifactRow = artifactPage.rows[0],
    artifactNext =
      artifactRow === undefined
        ? null
        : queries.readArtifactTimelinePage({
            kind: "md",
            limit: 2,
            after: {
              occurredAt: artifactRow.occurredAt,
              relative: artifactRow.relative,
              packageDir: artifactRow.packageDir,
            },
          });
  assert.throws(() => queries.readArtifactTimelinePage({ kind: "md", limit: 0 }), /limit/u);
  const entities = ["agent", "squad", "execution", "review", "runtime-session", "settings", "missing"].map((kind) => ({
    kind,
    rows: queries.listEntities(kind),
  }));
  return {
    entities,
    entityCounts: entities.map(({ kind, rows }) => [kind, queries.countEntities(kind, {}), rows.length]),
    filteredEntityCount: queries.countEntities("runtime-session", { runtimeSessionId: "runtime-query-session" }),
    singleEntities: entities.flatMap(({ kind, rows }) => rows.map(({ id }) => queries.getEntity(kind, id))),
    pinned,
    installation: queries.readRuntimeInstallation("runtime-query-installation"),
    installations: queries.readRuntimeInstallations(),
    session: queries.readRuntimeSession("runtime-query-session"),
    sessions: queries.readRuntimeSessions(),
    pointSession: queries.readRuntimeSessions({ runtimeSessionId: "runtime-query-session" }),
    missingPointSession: queries.readRuntimeSessions({ runtimeSessionId: "missing" }),
    unsettledPointSession: queries.readRuntimeSessions({
      runtimeSessionId: "runtime-query-session",
      unsettledOnly: true,
    }),
    unsettledSessions: queries.readRuntimeSessions({ unsettledOnly: true }),
    sessionsForTask: queries.readRuntimeSessionsForTask("task-parity"),
    emptySessions: queries.readRuntimeSessionsForTask("missing"),
    page: queries.readRuntimeSessionPage({ limit: 1 }),
    scopedPage: queries.readRuntimeSessionPage({ limit: 1, taskId: "task-parity" }),
    emptyPage: queries.readRuntimeSessionPage({ limit: 1, afterRuntimeSessionId: "zzz" }),
    run,
    missingRun: queries.readSquadRun("missing"),
    runs: queries.readSquadRuns(),
    intervals: queries.readTaskIdsForTaskContractMigration().map((id) => queries.readLeaseIntervals(id)),
    latestExecutionIntervals: queries
      .readTaskIdsForTaskContractMigration()
      .flatMap((id) => queries.readLeaseIntervals(id).map((interval) => [id, interval.executionId] as const))
      .map(([taskId, executionId]) => [
        taskId,
        executionId,
        queries.readLatestLeaseIntervalForExecution(taskId, executionId),
      ]),
    missingLatestExecutionInterval: queries.readLatestLeaseIntervalForExecution("missing", "missing"),
    latestIntervals: queries.readTaskIdsForTaskContractMigration().map((id) => queries.readLatestLeaseInterval(id)),
    missingLatestInterval: queries.readLatestLeaseInterval("missing"),
    artifacts: ["replay-agent", "deleted-agent", "retired-agent", "missing"].map((id) =>
      queries.readArtifactEntityState("agent", id),
    ),
    documents,
    artifactPage,
    artifactNext,
    artifactHtml: queries.readArtifactTimelinePage({ kind: "html", limit: 1 }),
    artifactRaw: queries.readArtifactTimelinePage({ kind: "raw", limit: 1 }),
    prefix: queries.readDocuments("tasks/task-parity-fixture/"),
    decisionsMetadata: queries.readDecisions(["dec_PG_PARITY"], false),
    decisionMetadata: queries.readDecision("dec_PG_PARITY", false),
    metadata: documents.documents.map(({ path }) => queries.readDocumentMetadata(path)),
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

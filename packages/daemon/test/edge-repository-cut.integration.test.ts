// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { repositoryCutFixture, seedRepositoryFamilies } from "./edge-repository-cut.fixtures.ts";

test("repository families survive real snapshot and delta update/delete with center query parity", async (t) => {
  const f = repositoryCutFixture(t);
  seedRepositoryFamilies(f.db);
  await f.transfer("snapshot");
  const parity = () => {
    const read = (q: typeof f.center) => ({
      installations: q.readRuntimeInstallations(),
      installation: q.readRuntimeInstallation("installation-1"),
      sessions: q.readRuntimeSessions(),
      session: q.readRuntimeSession("runtime-1"),
      taskSessions: q.readRuntimeSessionsForTask("task-1"),
      sessionsPage: q.readRuntimeSessionPage({ taskId: "task-1", limit: 1 }),
      dispatches: q.readRuntimeDispatches(),
      dispatch: q.readRuntimeDispatchById("dispatch-1"),
      sessionDispatches: q.readRuntimeDispatchesBySession("runtime-1"),
      taskDispatches: q.readRuntimeDispatchesByTaskExecution("task-1", "execution-1"),
      attemptDispatches: q.readRuntimeDispatchesByAttemptGroup("attempt-1"),
      dispatchPage: q.readRuntimeDispatchPage({ startedAtGte: "2026-01-01", limit: 1 }),
      sessionEvents: q.readRuntimeSessionEvents("runtime-1", 0, 10),
      settings: q.getEntity("settings", "repository"),
      provenance: q.readSettingsEvent(),
      witness: q.readEntityVersionWitness("settings/repository"),
      schedules: q.readScheduleEvents("schedule-1"),
      outputs: q.readScheduleOutputEvents(["runtime-1"]),
      ci: q.readCiRunObservations(2),
      pins: q.listPinnedEntities(),
      lease: q.readLeaseIntervals("task-1"),
      squad: q.getEntity("squad", "squad-1"),
      runs: q.readSquadRuns(),
      ready: q.squadRunProjectionReady(),
    });
    assert.deepEqual(f.read(read), read(f.center));
  };
  parity();
  assert.equal(f.read((q) => q.readRuntimeSessionsForTask("task-1")).length, 2);
  assert.equal(f.read((q) => q.readSettingsEvent())?.workspaceRevision, 10);
  assert.equal(f.read((q) => q.readCiRunObservations(2)).events.length, 1);
  assert.equal(f.read((q) => q.readScheduleOutputEvents(["runtime-1"])).length, 1);
  assert.equal(f.read((q) => q.readLeaseIntervals("task-1"))[0]?.releasedRevision, null);
  assert.equal(f.read((q) => q.listPinnedEntities())[0]?.entityRef, "squad/squad-1");
  assert.ok(!f.source.manifest(100)!.some((e) => /event_source|archived_entity/u.test(e.path)));
  const model = f.center.readEdgeReadModel();
  assert.ok(
    !model.rows.repository.some((r) => r.table === "event_index" && r.values.op_id === "op-17"),
    "unrelated canonical events must not be exported",
  );
  assert.throws(
    () => f.read((q) => q.readRuntimeSessions(), "different-owner"),
    (e: { code: string }) => e.code === "authorization_denied",
  );
  assert.equal(
    f.read((q) => q.readRuntimeSession("missing")),
    null,
  );
  assert.throws(() => f.read((q) => q.readRuntimeDispatchPage({ startedAtGte: "", limit: 0 })), /limit/u);
  const page = f.read((q) => q.readRuntimeDispatchPage({ startedAtGte: "", limit: 1 }));
  assert.equal(page.done, false);
  const last = f.read((q) => q.readRuntimeDispatchPage({ startedAtGte: "", limit: 1, cursor: page.nextCursor! }));
  assert.equal(last.done, true);
  assert.equal(last.nextCursor, null);
  assert.equal(last.rows.length, 1);
  const sessionPage = f.read((q) => q.readRuntimeSessionPage({ limit: 1 }));
  const sessionLast = f.read((q) =>
    q.readRuntimeSessionPage({ limit: 1, afterRuntimeSessionId: sessionPage.nextRuntimeSessionId! }),
  );
  assert.equal(sessionLast.nextRuntimeSessionId, null);
  assert.equal(sessionLast.remainingCount, 0);

  f.db.exec(`UPDATE runtime_installation SET value_json = json_set(value_json, '$.version', '2');
    UPDATE runtime_session SET value_json = json_set(value_json, '$.liveness', 'exited');
    UPDATE runtime_session_task_binding SET bound_at = '2026-10-07T01:00:00Z';
    UPDATE pinned_entities SET pinned_by = 'new-owner';
    UPDATE lease_interval SET released_revision = 101;
    UPDATE squad_run_projection SET revision = 2, state_json = json_set(state_json, '$.phase', 'converged');
    UPDATE entity_projection SET value_json = json_set(value_json, '$.name', 'updated');
    UPDATE event_index SET event_json = json_set(event_json, '$.occurredAt', '2026-10-07T02:00:00Z');`);
  await f.next();
  const changed = await f.transfer("delta");
  assert.ok(
    changed.some((frame) => frame.schema === "fleet.delta.page/v1" && frame.changes.some((c) => c.op === "put")),
  );
  parity();
  assert.equal(f.read((q) => q.readRuntimeInstallation("installation-1"))?.version, "2");
  assert.equal(f.read((q) => q.readLeaseIntervals("task-1"))[0]?.releasedRevision, 101);
  for (const table of [
    "runtime_installation",
    "runtime_session",
    "runtime_session_task_binding",
    "pinned_entities",
    "lease_interval",
    "squad_run_projection",
    "entity_projection",
    "event_index",
  ])
    f.db.exec(`DELETE FROM ${table}`);
  await f.next();
  const deleted = await f.transfer("delta");
  assert.ok(
    deleted.some((frame) => frame.schema === "fleet.delta.page/v1" && frame.changes.some((c) => c.op === "delete")),
  );
  parity();
  assert.deepEqual(
    f.read((q) => q.readRuntimeSessions()),
    [],
  );
  assert.equal(
    f.read((q) => q.readSettingsEvent()),
    null,
  );
  assert.deepEqual(
    f.read((q) => q.readLeaseIntervals("task-1")),
    [],
  );
  t.diagnostic(
    "snapshot 100 -> delta update 101 -> delta delete 102: runtime installation/session/binding, settings/provenance/witness, schedule/CI/output, squad, pin, lease parity",
  );
});

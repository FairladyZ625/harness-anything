// harness-test-tier: integration
import { sha256Bytes, publicRuntimeInstallation, publicRuntimeSession } from "@harness-anything/kernel";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { makeOffer } from "../src/fleet/center-replica-offer.ts";
import { readEdgeRuntimeResult } from "../src/runtime-result-read.ts";
import { repositoryCutFixture, seedRepositoryFamilies } from "./edge-repository-cut.fixtures.ts";

test("repository families survive real snapshot and delta update/delete with center query parity", async (t) => {
  const f = repositoryCutFixture(t);
  seedRepositoryFamilies(f.db);
  await f.transfer("snapshot");
  const parity = () => {
    const read = (q: typeof f.center) => ({
      installations: q.readRuntimeInstallations().map(publicRuntimeInstallation),
      installation: q.readRuntimeInstallation("installation-1")
        ? publicRuntimeInstallation(q.readRuntimeInstallation("installation-1")!)
        : null,
      sessions: q.readRuntimeSessions().map(publicRuntimeSession),
      session: q.readRuntimeSession("runtime-1") ? publicRuntimeSession(q.readRuntimeSession("runtime-1")!) : null,
      taskSessions: q.readRuntimeSessionsForTask("task-1").map(publicRuntimeSession),
      taskRuntimeBatch: q.readTaskRuntimeBatch({ taskIds: ["task-1"] }),
      taskStatuses: q.readTaskStatuses(["task-1"]),
      sessionsPage: {
        ...q.readRuntimeSessionPage({ taskId: "task-1", limit: 1 }),
        rows: q.readRuntimeSessionPage({ taskId: "task-1", limit: 1 }).rows.map(publicRuntimeSession),
      },
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
  assert.equal(
    JSON.stringify(model.rows).includes("/private/owner"),
    false,
    "shared public selection excludes cwd, transcript and installation host metadata before replication",
  );
  assert.equal(
    f.center.readRuntimeSession("runtime-1")?.transcriptRef,
    "file:/private/owner/session.jsonl",
    "the control projection retains its accepted source metadata",
  );
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

test("runtime result CAS shares the snapshot and delta cut, rejects missing blocks and retains historical bytes", async (t) => {
  const f = repositoryCutFixture(t);
  seedRepositoryFamilies(f.db);
  const first = Buffer.from("完整结果\n".repeat(10_000)),
    second = Buffer.from("Second complete result\n".repeat(500)),
    sha = sha256Bytes(first),
    sha2 = sha256Bytes(second),
    ref = (digest: string) => `artifact:runtime-result/sha256/${digest}`;
  const event = (digest: string, body: Uint8Array) => ({
    schema: "agent-runtime-event/v1",
    type: "runtime_session_outcome_observed",
    eventId: "result-event",
    workspaceRevision: 50,
    opId: "result-event",
    actor: { principal: { personId: "owner" }, executor: null },
    source: "local",
    occurredAt: "2026-10-07T00:00:00Z",
    payload: {
      runtimeSessionId: "runtime-1",
      outcome: "succeeded",
      exitCode: 0,
      resultRef: ref(digest),
      result: { sha256: digest, size: body.byteLength, mediaType: "text/plain; charset=utf-8" },
    },
  });
  f.db.prepare("INSERT INTO event_index VALUES ('result-event', 50, NULL, ?)").run(JSON.stringify(event(sha, first)));
  assert.throws(() => f.source.activate(), /Runtime result.*unavailable/u, "an incomplete center cut is never offered");
  assert.equal(f.source.latest(), null);
  f.contents.set(sha, first);
  f.db
    .prepare(
      "UPDATE runtime_session SET value_json = json_set(value_json, '$.resultRef', ?) WHERE runtime_session_id = 'runtime-1'",
    )
    .run(ref(sha2));
  assert.throws(
    () => f.source.activate(),
    /has no content claim/u,
    "a session reference cannot advertise a cut without its result claim",
  );
  f.db
    .prepare(
      "UPDATE runtime_session SET value_json = json_set(value_json, '$.resultRef', ?) WHERE runtime_session_id = 'runtime-1'",
    )
    .run(ref(sha));
  await f.transfer("snapshot");
  assert.equal(readEdgeRuntimeResult(f.viewRoot, "families", "edge", ref(sha)), first.toString());
  const frozen = f.source.latest()!;
  assert.deepEqual(f.source.activate(), frozen, "activating the same accepted cut never replaces its manifest");
  await f.next();
  await f.transfer("delta");
  f.contents.set(sha2, second);
  f.db
    .prepare("UPDATE event_index SET event_json = ? WHERE op_id = 'result-event'")
    .run(JSON.stringify(event(sha2, second)));
  f.db
    .prepare(
      "UPDATE runtime_session SET value_json = json_set(value_json, '$.resultRef', ?) WHERE runtime_session_id = 'runtime-1'",
    )
    .run(ref(sha2));
  await f.next();
  await assert.rejects(f.transfer("delta", sha2), /transfer blob missing/u);
  assert.equal(
    readEdgeRuntimeResult(f.viewRoot, "families", "edge", ref(sha)),
    first.toString(),
    "incomplete transfer cannot switch current",
  );
  await f.transfer("delta");
  assert.equal(readEdgeRuntimeResult(f.viewRoot, "families", "edge", ref(sha2)), second.toString());
  assert.throws(
    () => readEdgeRuntimeResult(f.viewRoot, "families", "edge", ref(sha)),
    /not present in the current cut/u,
  );
  const oldCas = path.join(f.viewRoot, "repos", "families", "cas", "sha256", sha.slice(0, 2), sha);
  assert.equal(
    readFileSync(oldCas).toString(),
    first.toString(),
    "previous retained edge cut still owns its result bytes",
  );
  f.db.prepare("DELETE FROM event_index WHERE op_id = 'result-event'").run();
  f.db.exec("UPDATE runtime_session SET value_json = json_remove(value_json, '$.resultRef')");
  await f.next();
  await f.transfer("delta");
  assert.throws(() => readEdgeRuntimeResult(f.viewRoot, "families", "edge", ref(sha2)), /not present/u);
  assert.equal(existsSync(oldCas), false, "edge GC can delete bytes after the last referencing cut is retired");
  for (let i = 0; i < 61; i++) await f.next();
  assert.equal(f.source.cut(100), null);
  assert.ok(f.source.cut(101), "the oldest retained cut still references the initial result");
  assert.deepEqual(
    f.source.content({ sha256: sha, size: first.byteLength, mediaType: "text/plain; charset=utf-8" }),
    first,
    "center GC traces all retained manifests, including results absent from current and change puts",
  );
});

test("a batched canonical advance offers only a complete head model, folding intermediate document deltas", async (t) => {
  const f = repositoryCutFixture(t);
  seedRepositoryFamilies(f.db);
  await f.transfer("snapshot");
  f.db.exec("UPDATE runtime_session SET value_json = json_set(value_json, '$.liveness', 'exited')");
  await f.next(2);
  await assert.rejects(
    () =>
      makeOffer(
        { nodeId: "edge", viewId: "edge", repoId: "families" },
        null,
        f.source.cut(101)!,
        f.source,
        "2026-10-07T00:00:00Z",
      ),
    /no read model at its canonical revision/u,
  );
  const frames = await f.transfer("delta");
  const begin = frames.find((frame) => frame.schema === "fleet.delta.begin/v1");
  assert.equal(
    begin?.schema === "fleet.delta.begin/v1" ? begin.toCut.revision : null,
    102,
    "revision 101 has no model at that cut and must never be advertised to the reader",
  );
  assert.equal(f.read((q) => q.readRuntimeSession("runtime-1"))?.liveness, "exited");
});

test("historical null results remain explicitly unavailable through snapshot and offline reads", async (t) => {
  const f = repositoryCutFixture(t),
    digest = "6fae66d215fbaaa52c1d01c2c66def801f9f93c63bc86c9eca0ead4501642c15",
    resultRef = `artifact:runtime-result/sha256/${digest}`,
    historical = JSON.stringify({
      schema: "agent-runtime-event/v1",
      type: "runtime_session_outcome_observed",
      workspaceRevision: 50,
      eventId: "historical-null",
      opId: "historical-null",
      actor: { principal: { personId: "owner" }, executor: null },
      source: "local",
      occurredAt: "2026-09-02T09:59:46.662Z",
      payload: { runtimeSessionId: "runtime-1", outcome: "succeeded", exitCode: 0, resultRef, result: null },
    });
  seedRepositoryFamilies(f.db);
  f.db.prepare("INSERT INTO event_index VALUES ('historical-null', 50, NULL, ?)").run(historical);
  f.db
    .prepare(
      "UPDATE runtime_session SET value_json = json_set(value_json, '$.resultRef', ?) WHERE runtime_session_id = 'runtime-1'",
    )
    .run(resultRef);
  await f.transfer("snapshot");
  const marker = f.source
    .manifest(100)!
    .find((entry) => entry.path === `.read-model/runtime-results-unavailable/${digest}`)!;
  assert.ok(marker, "the cut explicitly carries the historical result status");
  assert.deepEqual(JSON.parse(Buffer.from(f.source.content(marker.blob)).toString()), {
    availability: "unavailable",
    downloadable: false,
    resultRef,
  });
  const session = f.read((projection) => projection.readRuntimeSession("runtime-1"));
  assert.equal(session?.resultRef, resultRef);
  assert.equal((session as unknown as { resultAvailability: string }).resultAvailability, "unavailable");
  assert.equal((session as unknown as { resultDownloadable: boolean }).resultDownloadable, false);
  assert.throws(() => readEdgeRuntimeResult(f.viewRoot, "families", "edge", resultRef), {
    code: "runtime_result_unavailable",
  });
  assert.equal(
    f.db.prepare("SELECT event_json FROM event_index WHERE op_id='historical-null'").get()?.event_json,
    historical,
  );
  await f.next();
  await f.transfer("delta");
  assert.equal(f.source.manifest(101)!.filter((entry) => entry.path === marker.path).length, 1);
});

test("legacy schedule result details preserve malformed and missing refs as unavailable", async (t) => {
  for (const resultRef of [
    `artifact:runtime-result/sha256/${"a".repeat(64)} Occurrence worktree retained at /fixture/occ-old (uncommitted changes).`,
    "artifact:runtime-result/not-a-digest",
    `artifact:runtime-result/sha256/${"b".repeat(64)}`,
  ]) {
    const f = repositoryCutFixture(t);
    seedRepositoryFamilies(f.db);
    const historical = JSON.stringify({
      schema: "schedule-event/v1",
      type: "schedule_settled",
      eventId: "legacy-schedule",
      workspaceRevision: 50,
      opId: "legacy-schedule",
      payload: { schedule: { status: { lastRun: { detail: resultRef } } } },
    });
    f.db.prepare("INSERT INTO event_index VALUES ('legacy-schedule', 50, NULL, ?)").run(historical);
    f.db
      .prepare(
        "UPDATE runtime_session SET value_json = json_set(value_json, '$.resultRef', ?) WHERE runtime_session_id='runtime-1'",
      )
      .run(resultRef);
    await f.transfer("snapshot");
    const session = f.read((q) => q.readRuntimeSession("runtime-1")) as unknown as {
      resultRef: string;
      resultAvailability: string;
      resultDownloadable: boolean;
    };
    assert.equal(session.resultRef, resultRef);
    assert.equal(session.resultAvailability, "unavailable");
    assert.equal(session.resultDownloadable, false);
    const markers = f.source
      .manifest(100)!
      .filter((entry) => entry.path.startsWith(".read-model/runtime-results-unavailable/"));
    assert.equal(markers.length, 1);
    assert.deepEqual(JSON.parse(Buffer.from(f.source.content(markers[0]!.blob)).toString()), {
      resultRef,
      availability: "unavailable",
      downloadable: false,
    });
    assert.throws(() => readEdgeRuntimeResult(f.viewRoot, "families", "edge", resultRef), {
      code: "runtime_result_unavailable",
    });
    assert.equal(
      f.db.prepare("SELECT event_json FROM event_index WHERE op_id='legacy-schedule'").get()?.event_json,
      historical,
    );
    await f.next();
    await f.transfer("delta");
    assert.ok(f.source.manifest(101)!.some((entry) => entry.path === markers[0]!.path));
  }
});

test("legacy detail never hides a current outcome's missing or corrupt claim", (t) => {
  for (const bytes of [null, Buffer.from("corrupt")]) {
    const f = repositoryCutFixture(t);
    seedRepositoryFamilies(f.db);
    const digest = "d".repeat(64),
      resultRef = `artifact:runtime-result/sha256/${digest}`;
    f.db.prepare("INSERT INTO event_index VALUES ('legacy-detail', 49, NULL, ?)").run(
      JSON.stringify({
        schema: "schedule-event/v1",
        payload: { schedule: { status: { lastRun: { detail: resultRef } } } },
      }),
    );
    f.db.prepare("INSERT INTO event_index VALUES ('current-claim', 50, NULL, ?)").run(
      JSON.stringify({
        schema: "agent-runtime-event/v1",
        type: "runtime_session_outcome_observed",
        payload: {
          runtimeSessionId: "runtime-1",
          resultRef,
          result: { sha256: digest, size: 7, mediaType: "text/plain; charset=utf-8" },
        },
      }),
    );
    if (bytes) f.contents.set(digest, bytes);
    assert.throws(() => f.source.activate(), /Runtime result.*unavailable/u);
    assert.equal(f.source.latest(), null);
  }
});

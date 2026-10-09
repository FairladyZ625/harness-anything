// harness-test-tier: integration
import { edgeReadModelEntries } from "../../kernel/test/store/replica-model.fixture.ts";
import {
  parseCanonicalEvent,
  serializePersistedCanonicalEvent,
  sha256Bytes,
  type PersistedCanonicalEventV1,
  sha256Text,
  publicRuntimeInstallation,
  publicRuntimeSession,
} from "@harness-anything/kernel";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fleetManifestDigest } from "../src/fleet/contract.ts";
import { makeOffer, offerFrames } from "../src/fleet/center-replica-offer.ts";
import { readEdgeRuntimeResult } from "../src/runtime-result-read.ts";
import { repositoryCutFixture, seedRepositoryFamilies } from "./edge-repository-cut.fixtures.ts";

test("repository families survive real snapshot and delta update/delete with center query parity", async (t) => {
  const f = repositoryCutFixture(t);
  seedRepositoryFamilies(f.db);
  // Schema generation 8 binds the canonical serializer and sparse manifest identity.
  f.center.readEdgeReadModel(({ rows }) => {
    const entries = [...edgeReadModelEntries({ sourceRevision: 100, rootThreshold: 10, rows })];
    assert.equal(entries.length, 20);
    assert.equal(
      fleetManifestDigest(
        entries.map(({ path, text }) => ({
          path,
          blob: { sha256: sha256Text(text), size: Buffer.byteLength(text), mediaType: "application/json" },
        })),
      ),
      "5338c4a717353217e5717f248ab0b28f23e4413545393d7fcaaedabac5654f2e",
    );
  });
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
  const model = f.center.readEdgeReadModel((model) => ({
    ...model,
    rows: { ...model.rows, repository: [...model.rows.repository] },
  }));
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
  assert.equal(
    parseCanonicalEvent(serializePersistedCanonicalEvent(event(sha, first) as PersistedCanonicalEventV1)).schema,
    "agent-runtime-event/v1",
  );
  assert.throws(
    () =>
      serializePersistedCanonicalEvent({
        ...event(sha, first),
        payload: { ...event(sha, first).payload, resultRef: ref(sha2) },
      } as PersistedCanonicalEventV1),
    /runtime outcome observation is invalid/u,
    "the canonical event boundary rejects a session result ref that disagrees with its claim",
  );
  f.db.prepare("INSERT INTO event_index VALUES ('result-event', 50, NULL, ?)").run(JSON.stringify(event(sha, first)));
  // Byte integrity is enforced when the immutable claim is consumed for delivery.
  // The canonical writer already binds a session's result reference to its claim.
  await assert.rejects(f.transfer("snapshot"), /canonical content blob.*unavailable or corrupt/u);
  assert.equal(f.current(), null);
  f.contents.set(sha, first);
  f.db
    .prepare(
      "UPDATE runtime_session SET value_json=json_set(value_json, '$.resultRef', ?) WHERE runtime_session_id='runtime-1'",
    )
    .run(ref(sha));
  await f.next();
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
  assert.equal(existsSync(oldCas), true, "the local retention window still owns historical result bytes");
  for (let i = 0; i < 60; i++) {
    await f.next();
    await f.transfer("delta");
  }
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
  assert.equal(f.source.cut(101), null, "unpublished intermediate revisions have no cut");
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

test("legacy detail never hides a current outcome's missing or corrupt claim", async (t) => {
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
    await assert.rejects(f.transfer("snapshot"), /canonical content blob.*unavailable or corrupt/u);
    assert.equal(f.current(), null);
  }
});

test("read model repository rows are lazy, repeatable and consumed inside the database read", (t) => {
  const f = repositoryCutFixture(t);
  const insert = f.db.prepare("INSERT INTO runtime_installation VALUES (?, ?, ?)");
  insert.run("first", 1, JSON.stringify({ installationId: "first", hostRef: "/private/host" }));
  // The next row must only be decoded when the consumer advances to it. Eager table materialization
  // reaches this row before the callback can consume or stop at the first logical unit.
  insert.run("second", 2, "invalid-json");
  f.center.readEdgeReadModel(({ rows }) => {
    for (let pass = 0; pass < 2; pass++) {
      const iterator = rows.repository[Symbol.iterator]();
      const first = iterator.next();
      assert.equal(first.done, false);
      assert.equal(first.value?.values.installation_id, "first");
      assert.doesNotMatch(String(first.value?.values.value_json), /private/u);
      iterator.return?.();
    }
    assert.throws(() => [...rows.repository], SyntaxError, "later invalid rows are still validated");
  });
  f.db.prepare("DELETE FROM runtime_installation WHERE installation_id = ?").run("second");
  f.center.readEdgeReadModel(({ rows }) => {
    const iterator = rows.repository[Symbol.iterator]();
    assert.equal(iterator.next().done, false);
    assert.equal(iterator.next().done, true);
    assert.equal(iterator.next().done, true, "the final SQL row terminates the reader");
  });
});

test("snapshot manifest pages terminate at the final page and reconcile before blob delivery", async (t) => {
  const f = repositoryCutFixture(t);
  const insert = f.db.prepare("INSERT INTO pinned_entities VALUES (?, ?, ?)");
  for (let index = 0; index < 257; index++) insert.run(`task/task-${index}`, "now", "owner");
  const cut = (await f.source.prepare())!;
  const cursors: string[] = [];
  let contentReads = 0;
  const source = {
    ...f.source,
    delivery: {
      ...f.source.delivery,
      manifestPage: async (revision: number, afterPath: string) => {
        cursors.push(afterPath);
        return f.source.manifestPage(revision, afterPath);
      },
      content: async (blob: Parameters<typeof f.source.content>[0]) => {
        contentReads++;
        return f.source.content(blob);
      },
    },
  };
  const key = { nodeId: "edge", viewId: "edge", repoId: "families" };
  const offer = { ...key, ...(await makeOffer(key, null, cut, source, "2026-10-07T00:00:00Z")) };
  const sizes: number[] = [];
  for await (const frame of offerFrames(offer, source, { owner: "owner", digest: "a".repeat(64) }))
    if (frame.schema === "fleet.snapshot.page/v1") sizes.push(frame.entries.length);
  assert.deepEqual(sizes, [128, 128, 2]);
  const paths = f.source.manifest(cut.revision)!;
  assert.deepEqual(
    cursors,
    ["", paths[127]!.path, paths[255]!.path, "", paths[127]!.path, paths[255]!.path],
    "done ends both passes without a page beyond the final one",
  );
  const readsBeforeCorruption = contentReads;
  const corrupt = {
    ...source,
    delivery: {
      ...source.delivery,
      manifestPage: async (revision: number, afterPath: string) => {
        const page = f.source.manifestPage(revision, afterPath)!;
        return {
          ...page,
          entries: page.entries.map((entry, index) =>
            afterPath === paths[127]!.path && index === 0
              ? { ...entry, blob: { ...entry.blob, sha256: "f".repeat(64) } }
              : entry,
          ),
        };
      },
    },
  };
  const seen: string[] = [];
  await assert.rejects(async () => {
    for await (const frame of offerFrames(offer, corrupt, { owner: "owner", digest: "a".repeat(64) }))
      seen.push(frame.schema);
  }, /manifest is unavailable or corrupt/u);
  assert.equal(contentReads, readsBeforeCorruption, "whole-manifest validation is retained before any blob delivery");
  assert.ok(!seen.includes("fleet.snapshot.finish/v1"), "a partial manifest can never publish an edge cut");
});

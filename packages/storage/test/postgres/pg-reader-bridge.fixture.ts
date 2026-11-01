import { materializePgProjectionEvents } from "../../src/pg/pg-task-event-materialize.ts";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import type { TaskProjection, TaskProjectionReader } from "@harness-anything/kernel";
import { makeTaskProjectionReader } from "../../src/projection/rebuildable-task-projection.ts";
import { createPgTaskQueryReader } from "../../src/pg/pg-task-query-reader.ts";
import { PG_PROJECTION_SCHEMA_VERSION } from "../../src/pg/pg-projection-schema.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import type { PgProjectionScope } from "../../src/pg/pg-task-event-materialize.ts";

export async function assertPgReaderBridge(
  reader: TaskProjectionReader,
  sqlite: TaskProjection,
  pool: Pool,
  connectionString: string,
  scope: PgProjectionScope,
  repoId: string,
): Promise<void> {
  const error = new Error("reader callback failure");
  assert.throws(
    () =>
      reader.withSession(() => {
        throw error;
      }),
    (actual) => actual === error,
  );
  const escaped = reader.withSession((queries) => {
    assert.throws(() => reader.withSession(() => null), /nested/);
    assert.throws(() => reader.close(), /during a session/);
    return queries;
  });
  assert.throws(() => escaped.readCut(), /active reader session/);
  assert.equal(reader.withSession((queries) => queries.readCut()).status, "ready");
  assert.throws(
    () => createPgTaskQueryReader({ connectionString, scope, repoId, startupTimeoutMs: 0 }),
    /startup timeout/,
  );
  assert.throws(() => createPgTaskQueryReader({ connectionString, scope, repoId, queryTimeoutMs: 0 }), /query timeout/);
  const clockAt = "2026-08-11T00:30:00.000Z",
    clock = makeTaskProjectionReader({
      repoId,
      now: () => clockAt,
      storage: { backend: "postgres", connectionString, scope },
    });
  try {
    assert.deepEqual(
      clock.withSession((queries) => queries.currentLease("task-blocker")),
      sqlite.currentLease("task-blocker", clockAt),
    );
    assert.deepEqual(
      clock.withSession((queries) => queries.read("task-blocker").snapshot.lease),
      sqlite.currentLease("task-blocker", clockAt),
    );
  } finally {
    clock.close();
  }
  assert.throws(() => clock.withSession(() => null), /closed/);
  clock.close();
  for (const hiddenScope of [
    { ...scope, tenantId: "tenant-hidden" },
    { ...scope, projectId: "project-hidden" },
    { ...scope, policyEpoch: scope.policyEpoch + 1 },
  ]) {
    const hidden = makeTaskProjectionReader({
      repoId,
      storage: { backend: "postgres", connectionString, scope: hiddenScope },
    });
    try {
      hidden.withSession((queries) => {
        assert.equal(queries.readTaskExists("task-parity"), false);
        assert.equal(queries.readFact("F-11111111").fact, null);
        assert.deepEqual(queries.readRuntimeSessions(), []);
        assert.deepEqual(queries.listEntities("agent"), []);
      });
    } finally {
      hidden.close();
    }
  }
  const version = (value: number) =>
    withPostgresTransaction(
      pool,
      (client) =>
        client.query(
          "UPDATE ha_projection_meta SET schema_version=$4 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND projection_name='task/v1'",
          [scope.tenantId, scope.projectId, scope.policyEpoch, value],
        ),
      scope,
    );
  const seed = reader.withSession((queries) => queries.readCanonicalEvents(0, 1).events[0]!);
  await version(PG_PROJECTION_SCHEMA_VERSION - 1);
  try {
    let invoked = false;
    assert.throws(
      () =>
        reader.withSession(() => {
          invoked = true;
        }),
      (actual) => actual instanceof Error && "code" in actual && actual.code === "kernel_schema_mismatch",
    );
    assert.equal(invoked, false);
    await assert.rejects(
      withPostgresTransaction(
        pool,
        (client) => materializePgProjectionEvents(client, scope, { revision: seed.workspaceRevision, events: [seed] }),
        scope,
      ),
      (actual) => actual instanceof Error && "code" in actual && actual.code === "kernel_schema_mismatch",
    );
  } finally {
    await version(PG_PROJECTION_SCHEMA_VERSION);
  }
  assert.equal(reader.withSession((queries) => queries.readCut()).status, "ready");
}

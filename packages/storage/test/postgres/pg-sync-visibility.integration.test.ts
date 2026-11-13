// harness-test-tier: integration
import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { Pool } from "pg";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { canonicalLedgerCut } from "@harness-anything/kernel/internal/ports/canonical-event-store.ts";
import { serializePersistedCanonicalEvent } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makePostgresTaskEventStore } from "../../src/postgres/pg-task-event-store.ts";
import {
  withPostgresTransaction,
  backfillConfirmedLegacyOutcomes,
  isSyncRepWaitInterruptedNotice,
  afterPostgresCommit,
} from "../../src/postgres/transaction.ts";
import { pgReplicationHead, pgReplicationPage, pgOutcomes } from "../../src/postgres/pg-replication.ts";
import { prepareSqlBaseBackup } from "../../src/postgres/pg-basebackup.ts";
import { BASE_BACKUP_ARCHIVE_ROOT } from "../../src/fleet-basebackup-layout.ts";
import { bundle, docBundle, eventAt } from "../store/task-event-store.fixtures.ts";
import { openPgMigrationEndpoint } from "../../src/migration/postgres-endpoint.ts";
import { executePostgresRead } from "../../src/postgres/pg-event-store.ts";
import { createMigrationGrant } from "../../src/migration/postgres-grant.ts";
import { createPgStorageBackend } from "../../src/pg/backend.ts";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";

function attemptAt(revision: number) {
  const id = randomUUID(),
    payloadMarker = `marker_${id}`,
    original = eventAt(revision),
    event = {
      ...original,
      opId: `op_inj_${id}`,
      eventId: `evt_inj_${id}`,
      payload: { ...original.payload, task: { ...original.payload.task, title: payloadMarker } },
    };
  console.log(
    "ATTEMPT_KEY",
    JSON.stringify({
      opId: event.opId,
      eventId: event.eventId,
      payloadMarker,
      intentDigest: `sha256:${sha256Text(JSON.stringify([serializePersistedCanonicalEvent(event)]))}`,
    }),
  );
  return bundle(event);
}

let fixture: Awaited<ReturnType<typeof pgRuntimeFixture>>;
before(async () => {
  fixture = await pgRuntimeFixture();
});
after(async () => {
  await strict(fixture, false);
  await fixture.pool.end();
  await fixture.close();
});

test("SyncRep notice classification does not depend on translated message text", () => {
  assert.equal(isSyncRepWaitInterruptedNotice({ routine: "SyncRepWaitForLSN", message: "同步等待已取消" }), true);
  assert.equal(isSyncRepWaitInterruptedNotice({ file: "syncrep.c", code: "57P01" }), true);
  assert.equal(isSyncRepWaitInterruptedNotice({ code: "01000", message: "canceling synchronous replication" }), true);
  assert.equal(
    isSyncRepWaitInterruptedNotice({ code: "01000", routine: "other", message: "unrelated warning" }),
    false,
  );
});

test("a resolved COMMIT with a SyncRep warning neither rolls back nor runs commit work", async () => {
  const queries: string[] = [],
    released: unknown[] = [],
    notices: unknown[] = [],
    client = Object.assign(new EventEmitter(), {
      async query(sql: string) {
        queries.push(sql);
        if (sql === "COMMIT") client.emit("notice", { routine: "SyncRepWaitForLSN", code: "01000" });
        return { rows: [] };
      },
      release(error?: Error) {
        released.push(error);
      },
    }),
    pool = { connect: async () => client } as unknown as Pool;
  let advanced = false;
  await assert.rejects(
    withPostgresTransaction(
      pool,
      async (connection) => {
        afterPostgresCommit(connection, async () => {
          advanced = true;
        });
        return "accepted";
      },
      undefined,
      { onSyncRepInterrupted: (notice) => notices.push(notice) },
    ),
    { code: "sync_rep_wait_canceled" },
  );
  assert.deepEqual(queries, ["BEGIN", "COMMIT"]);
  assert.equal(advanced, false);
  assert.equal(notices.length, 1);
  assert.equal(released.length, 1);
  assert.ok(released[0] instanceof Error);
  assert.equal(client.listenerCount("notice"), 0);
  assert.equal(client.listenerCount("error"), 0);
});

test("replay completion discards row-lock WAL without issuing COMMIT", async () => {
  const queries: string[] = [],
    client = Object.assign(new EventEmitter(), {
      async query(sql: string) {
        queries.push(sql);
        return { rows: [] };
      },
      release() {},
    }),
    pool = { connect: async () => client } as unknown as Pool;
  let advanced = false;
  const result = await withPostgresTransaction(
    pool,
    async (connection) => {
      afterPostgresCommit(connection, async () => {
        advanced = true;
      });
      return { replayed: true };
    },
    undefined,
    { rollbackOnly: (value) => value.replayed },
  );
  assert.equal(result.replayed, true);
  assert.deepEqual(queries, ["BEGIN", "ROLLBACK"]);
  assert.equal(advanced, false);
});

test("legacy outcome without replication proof stays invisible", { timeout: 60_000 }, async () => {
  const scope = { tenantId: "sync", projectId: "sync", readers: [], policyEpoch: 1 },
    repoId = "sync";
  try {
    await fixture.adminPool.query(
      "INSERT INTO ha_repo_heads(tenant_id,project_id,repo_id,policy_epoch) VALUES('sync','sync','sync',1)",
    );
    await executePostgresRead(fixture.pool, scope, "head", { repoId });
    await fixture.adminPool.query(
      `INSERT INTO ha_command_outcomes(tenant_id,project_id,repo_id,op_id,status,intent_digest,intent_summary,
         recorded_at,member_op_ids,policy_epoch) VALUES('sync','sync','sync','op_legacy','accepted_durable',
         'sha256:legacy','legacy',clock_timestamp(),'{}',1)`,
    );
    await fixture.adminPool.query("ALTER SYSTEM SET synchronous_standby_names = '*'");
    await fixture.adminPool.query("SELECT pg_reload_conf()");
    while (
      (await fixture.adminPool.query("SHOW synchronous_standby_names")).rows[0]!.synchronous_standby_names !== "*"
    ) {
      // SHOW is the state probe; the enclosing test owns the hang guard.
    }
    await withPostgresTransaction(
      fixture.pool,
      (client) => backfillConfirmedLegacyOutcomes(client, scope, repoId),
      scope,
      { isolationLevel: "repeatable read" },
    );
    const result = await executePostgresRead(fixture.pool, scope, "outcome", { repoId, opId: "op_legacy" });
    console.log("LEGACY_NULL_READ", JSON.stringify(result));
    assert.equal(result, null);
    const store = makePostgresTaskEventStore({ pool: fixture.pool, scope, repoId });
    for (const intentDigest of ["sha256:legacy", "sha256:different"] as const)
      await assert.rejects(
        store.execute({
          operation: "reject",
          expectedRevision: 0,
          writerFence: { repoId, holderId: "writer", epoch: 1 },
          rejection: { opId: "op_legacy", intentDigest, summary: "legacy", rejectionCode: "rejected" },
        }),
        { code: "publication_indeterminate" },
      );
    await strict(fixture, false);
    await withPostgresTransaction(
      fixture.pool,
      (client) => backfillConfirmedLegacyOutcomes(client, scope, repoId),
      scope,
      { isolationLevel: "repeatable read" },
    );
    assert.equal(
      (await fixture.adminPool.query("SELECT replication_sequence FROM ha_command_outcomes WHERE op_id='op_legacy'"))
        .rows[0]!.replication_sequence,
      "0",
    );
    assert.ok(await store.execute({ operation: "outcome", opId: "op_legacy" }));
  } finally {
    await fixture.adminPool.query("ALTER SYSTEM RESET synchronous_standby_names");
    await fixture.adminPool.query("SELECT pg_reload_conf()");
  }
});

test(
  "interrupted COMMIT fences canonical reads, replication, backups and both previous-version outcomes",
  { timeout: 60_000 },
  async () => {
    const fixture = await pgRuntimeFixture(),
      scope = { tenantId: "fence", projectId: "fence", readers: [], policyEpoch: 1 },
      repoId = "fence",
      fence = { repoId, holderId: "writer", epoch: 1 },
      notices: unknown[] = [],
      store = makePostgresTaskEventStore({
        pool: fixture.pool,
        repoId,
        scope,
        onSyncRepInterrupted: (notice) => notices.push(notice),
      });
    let migrationGrant: Awaited<ReturnType<typeof createMigrationGrant>> | undefined;
    try {
      const owner = (
        await fixture.adminPool.query(
          "SELECT proowner::regrole::text AS owner,prosecdef FROM pg_proc WHERE proname='ha_is_lsn_sync_confirmed'",
        )
      ).rows[0];
      assert.deepEqual(owner, { owner: "ha_schema_owner", prosecdef: true });
      const base = attemptAt(1),
        pending = attemptAt(2);
      await store.append(base, 0, fence);
      const anchor = await withPostgresTransaction(
        fixture.pool,
        (client) => pgReplicationHead(client, scope, repoId),
        scope,
      );
      migrationGrant = await createMigrationGrant(fixture.adminPool, "case-d", [scope]);
      const migration = await openPgMigrationEndpoint({
        pool: fixture.adminPool,
        repoId,
        scope,
        preparedGrant: migrationGrant,
      });
      await strict(fixture, true);
      const writing = store.append(pending, 1, fence);
      const rejected = assert.rejects(writing, { code: "publication_indeterminate" });
      const pid = await blocked(fixture);
      assert.equal(await store.execute({ operation: "outcome", opId: pending.event.opId }), null);
      assert.equal((await store.readHead())?.revision, 1);
      await fixture.adminPool.query("SELECT pg_cancel_backend($1)", [pid]);
      await rejected;
      assert.equal(notices.length, 1);
      assert.deepEqual((notices[0] as { code: string }).code, "01000");
      console.log("SYNCREP_INTERRUPTION", JSON.stringify(notices));

      for (const status of ["accepted_durable", "rejected"] as const) {
        // v_prev omits the new column and ignores NoticeResponse: the database stamps it anyway.
        const client = await fixture.pool.connect(),
          opId = `prev_${status}_${randomUUID()}`;
        try {
          await client.query("BEGIN");
          await client.query(
            "SELECT set_config('ha.tenant_id','fence',true),set_config('ha.project_id','fence',true),set_config('ha.policy_epoch','1',true)",
          );
          await client.query(
            `INSERT INTO ha_command_outcomes(tenant_id,project_id,repo_id,op_id,status,intent_digest,intent_summary,
            rejection_code,recorded_at,member_op_ids,policy_epoch) VALUES('fence','fence','fence',$1,$2,'sha256:prev','prev',
            $3,clock_timestamp(),'{}',1)`,
            [opId, status, status === "rejected" ? "rejected" : null],
          );
          await client.query(
            `INSERT INTO ha_replication_positions(tenant_id,project_id,repo_id,history,sequence,revision,last_op_id,
            head_digest,writer_holder_id,writer_epoch,policy_epoch)
           SELECT 'fence','fence','fence',$1,MAX(sequence)+1,2,$2,'digest','writer',1,1
           FROM ha_replication_positions WHERE tenant_id='fence' AND project_id='fence' AND repo_id='fence'`,
            [anchor.history, opId],
          );
          const committing = client.query("COMMIT");
          await fixture.adminPool.query("SELECT pg_cancel_backend($1)", [await blocked(fixture)]);
          await committing;
        } finally {
          client.release();
        }
        const stamped = (
          await fixture.adminPool.query("SELECT replication_sequence FROM ha_command_outcomes WHERE op_id=$1", [opId])
        ).rows[0];
        assert.ok(Number(stamped.replication_sequence) > anchor.sequence);
        assert.equal(await store.execute({ operation: "outcome", opId }), null);
        await assert.rejects(
          store.execute({
            operation: "reject",
            expectedRevision: 2,
            writerFence: fence,
            rejection: { opId, intentDigest: "sha256:different", summary: "replay", rejectionCode: "rejected" },
          }),
          { code: "publication_indeterminate" },
        );
      }
      const observations: Record<string, unknown> = {};
      for (const operation of ["head", "stream", "batch", "events", "event", "outcome"] as const)
        observations[operation] = await executePostgresRead(fixture.pool, scope, operation, {
          repoId,
          cursor: null,
          maxItems: 10,
          key: "op_id",
          value: pending.event.opId,
          opId: pending.event.opId,
        });
      assert.equal(observations.event, null);
      assert.equal(observations.outcome, null);
      assert.equal(Number((observations.head as { revision: string }).revision), 1);
      assert.equal((observations.stream as { revision: number }).revision, 1);
      assert.equal((observations.batch as { sourceRevision: number }).sourceRevision, 1);
      assert.equal((observations.events as unknown[]).length, 1);
      for (const candidate of [
        pending,
        { ...pending, event: { ...pending.event, occurredAt: "2026-11-14T00:00:00Z" } },
      ])
        await assert.rejects(store.append(candidate, 1, fence), { code: "publication_indeterminate" });
      const replication = await withPostgresTransaction(
        fixture.pool,
        async (client) => ({
          head: await pgReplicationHead(client, scope, repoId),
          page: await pgReplicationPage(client, scope, repoId, anchor, 10),
          outcomes: await pgOutcomes(client, scope, repoId),
        }),
        scope,
        { isolationLevel: "repeatable read" },
      );
      assert.deepEqual(replication.head, anchor);
      assert.deepEqual(replication.page.commits, []);
      assert.equal(replication.page.done, true);
      assert.deepEqual(
        replication.outcomes.map((outcome) => outcome.opId),
        [base.event.opId],
      );
      const directory = path.join(fixture.root, "backup");
      const metadata = await prepareSqlBaseBackup(
        { directory, repoId, storage: { backend: "postgres", connectionString: fixture.connectionString, scope } },
        () => {},
        fixture.pool,
      );
      const seed = JSON.parse(
        readFileSync(
          path.join(directory, "payload", BASE_BACKUP_ARCHIVE_ROOT, "store/generations/3/canonical-seed.json"),
          "utf8",
        ),
      ) as { events: { opId: string }[]; outcomes: { opId: string }[] };
      assert.deepEqual(metadata.position, anchor);
      assert.deepEqual(
        seed.events.map((row) => row.opId),
        [base.event.opId],
      );
      assert.deepEqual(
        seed.outcomes.map((row) => row.opId),
        [base.event.opId],
      );
      const exported = await migration.export("case-d");
      assert.deepEqual(
        exported[0]!.outcomes.map((row) => row.opId),
        [base.event.opId],
      );
      assert.deepEqual(
        exported[0]!.events.map((row) => row.opId),
        [base.event.opId],
      );
      console.log("FENCED_SURFACES", JSON.stringify({ observations, replication, metadata, seed, exported }));
      await strict(fixture, false);
      await fixture.adminPool.query("TRUNCATE ha_repo_sync_watermarks");
      assert.equal((await store.readHead())?.revision, 2);
      const healed = (await fixture.adminPool.query("SELECT * FROM ha_repo_sync_watermarks")).rows;
      assert.equal(healed.length, 1);
      assert.equal(Number(healed[0]!.confirmed_revision), 2);
      assert.equal(Number(healed[0]!.confirmed_sequence), 4);
      console.log("COLD_START_WRITEBACK", JSON.stringify(healed));
      await strict(fixture, true);
      const terminated = attemptAt(3),
        terminating = store.append(terminated, 2, fence),
        terminationRejected = assert.rejects(terminating, { code: "publication_indeterminate" });
      await fixture.adminPool.query("SELECT pg_terminate_backend($1)", [await blocked(fixture)]);
      await terminationRejected;
      assert.equal(await store.execute({ operation: "outcome", opId: terminated.event.opId }), null);
      assert.equal((await store.readHead())?.revision, 2);
    } finally {
      await strict(fixture, false);
      await migrationGrant?.close();
      await fixture.pool.end();
      await fixture.close();
    }
  },
);

async function strict(fixture: Awaited<ReturnType<typeof pgRuntimeFixture>>, enabled: boolean) {
  await fixture.adminPool.query(
    enabled ? "ALTER SYSTEM SET synchronous_standby_names = '*'" : "ALTER SYSTEM RESET synchronous_standby_names",
  );
  await fixture.adminPool.query("SELECT pg_reload_conf()");
  while (
    (await fixture.adminPool.query("SHOW synchronous_standby_names")).rows[0]!.synchronous_standby_names !==
    (enabled ? "*" : "")
  ) {
    // SHOW is the state probe; the enclosing test owns the hang guard.
  }
}

test(
  "prepared migration reads export only the confirmed prefix without a synchronous WAL commit",
  { timeout: 60_000 },
  async () => {
    const scope = { tenantId: "export-gap", projectId: "export-gap", readers: [], policyEpoch: 1 },
      repoId = "export-gap",
      fence = { repoId, holderId: "writer", epoch: 1 };
    let grant: Awaited<ReturnType<typeof createMigrationGrant>> | undefined;
    const backend = createPgStorageBackend({ pool: fixture.pool, scope, repoId });
    try {
      const base = attemptAt(1);
      await backend.eventStore.append(base, 0, fence);
      const baseHead = await backend.eventStore.readHead();
      const baseDocument = docBundle(
        { currentCut: () => canonicalLedgerCut(repoId, baseHead) } as Parameters<typeof docBundle>[0],
        "confirmed document",
        2,
        `op_inj_${randomUUID()}`,
        "docs/confirmed.md",
      );
      await backend.eventStore.append(baseDocument, 1, fence);
      const documentHead = await backend.eventStore.readHead();
      const pending = docBundle(
        { currentCut: () => canonicalLedgerCut(repoId, documentHead) } as Parameters<typeof docBundle>[0],
        "unconfirmed document",
        3,
        `op_inj_${randomUUID()}`,
        "docs/pending.md",
      );
      console.log(
        "ATTEMPT_KEY",
        JSON.stringify({
          opId: pending.event.opId,
          eventId: pending.event.eventId,
          payloadMarker: "unconfirmed document",
          intentDigest: `sha256:${sha256Text(JSON.stringify([serializePersistedCanonicalEvent(pending.event)]))}`,
        }),
      );
      grant = await createMigrationGrant(fixture.adminPool, "export-gap", [scope]);
      const endpoint = await openPgMigrationEndpoint({ pool: fixture.adminPool, repoId, scope, preparedGrant: grant });
      await assert.rejects(endpoint.export("wrong-run"), { code: "storage_migration_mismatch" });
      await strict(fixture, true);
      // A complete head still receives the full same-dialect and logical projection audits.
      const complete = await endpoint.export("export-gap");
      assert.equal(complete[0]!.cut.revision, 2);
      const writing = backend.eventStore.append(pending, 2, fence),
        rejected = assert.rejects(writing, { code: "publication_indeterminate" });
      await fixture.adminPool.query("SELECT pg_cancel_backend($1)", [await blocked(fixture)]);
      await rejected;
      const tuples = await endpoint.export("export-gap"),
        tuple = tuples[0]!;
      assert.equal(tuples.length, 1);
      assert.deepEqual(
        tuple.events.map((row) => row.opId),
        [base.event.opId, baseDocument.event.opId],
      );
      assert.deepEqual(tuple.outcomes.map((row) => row.opId).sort(), [base.event.opId, baseDocument.event.opId].sort());
      assert.deepEqual(
        tuple.blobs.map((row) => row.sha256),
        [baseDocument.blobs[0]!.sha256],
      );
      assert.equal(tuple.cut.revision, 2);
      assert.equal(JSON.stringify(tuple).includes(pending.event.opId), false);
      assert.equal(JSON.stringify(tuple).includes(pending.blobs[0]!.sha256), false);
      assert.equal(
        (await fixture.adminPool.query("SELECT 1 FROM pg_namespace WHERE nspname LIKE 'ha_replay_%'")).rowCount,
        0,
      );
      console.log("MIGRATION_CONFIRMED_EXPORT", JSON.stringify({ complete, tuples }));
    } finally {
      await strict(fixture, false);
      await backend.projection.close();
      await grant?.close();
    }
  },
);

async function blocked(fixture: Awaited<ReturnType<typeof pgRuntimeFixture>>): Promise<number> {
  for (;;) {
    const row = (
      await fixture.adminPool.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE usename='ha_runtime' AND wait_event='SyncRep' AND state='active'",
      )
    ).rows[0];
    if (row) return row.pid;
  }
}

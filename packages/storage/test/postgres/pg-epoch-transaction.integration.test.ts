// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import { withPostgresCommitGuard } from "../../src/postgres/transaction.ts";
import { pgEpochTransactions } from "../../src/postgres/pg-epoch-transaction.ts";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";

test("PG writer epoch fence resists idle_in_transaction_session_timeout without leaking session state", async () => {
  const fixture = await pgRuntimeFixture();
  const authorityRole = "ha_epoch_timeout_probe";
  let authorityPool: Pool | undefined;
  try {
    await fixture.adminPool.query(`CREATE ROLE "${authorityRole}" LOGIN NOSUPERUSER BYPASSRLS`);
    await fixture.adminPool.query(`GRANT SELECT, INSERT, UPDATE ON ha_repo_writer_epochs TO "${authorityRole}"`);
    await fixture.adminPool.query(`GRANT SELECT ON ha_repo_heads TO "${authorityRole}"`);
    await fixture.adminPool.query(`ALTER ROLE "${authorityRole}" SET idle_in_transaction_session_timeout = '50ms'`);

    authorityPool = new Pool({
      connectionString: `postgres://${authorityRole}@127.0.0.1:${fixture.port}/postgres`,
      max: 1,
    });
    const configured = (
      await authorityPool.query<{ idle_in_transaction_session_timeout: string }>(
        "SHOW idle_in_transaction_session_timeout",
      )
    ).rows[0]!.idle_in_transaction_session_timeout;
    assert.equal(configured, "50ms");

    const epochs = pgEpochTransactions(authorityPool);
    const repoId = "pg-fence-idle-timeout";
    const holderId = "center-1";
    const now = "2026-11-13T00:00:00.000Z";
    try {
      const lease = await epochs.execute({ operation: "acquire", repoId, holderId, now });
      assert.ok(lease && typeof lease === "object");

      await epochs.execute({ operation: "begin", repoId, holderId, now, epoch: lease.epoch });
      // Wait inside PostgreSQL on a separate connection longer than the 50ms role timeout.
      await fixture.adminPool.query("SELECT pg_sleep(0.25)");
      await epochs.execute({ operation: "end", repoId, holderId, now });
    } finally {
      await epochs.close();
    }

    const after = (
      await authorityPool.query<{ idle_in_transaction_session_timeout: string }>(
        "SHOW idle_in_transaction_session_timeout",
      )
    ).rows[0]!.idle_in_transaction_session_timeout;
    assert.equal(after, "50ms", "SET LOCAL must revert when the fence transaction ends");
  } finally {
    await authorityPool?.end();
    await fixture.pool.end();
    await fixture.close();
  }
});

async function strict(fixture: Awaited<ReturnType<typeof pgRuntimeFixture>>, enabled: boolean) {
  await fixture.adminPool.query(
    enabled ? "ALTER SYSTEM SET synchronous_standby_names='*'" : "ALTER SYSTEM RESET synchronous_standby_names",
  );
  await fixture.adminPool.query("SELECT pg_reload_conf()");
  while (
    (await fixture.adminPool.query("SHOW synchronous_standby_names")).rows[0]!.synchronous_standby_names !==
    (enabled ? "*" : "")
  ) {
    /* configuration acknowledgement */
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test(
  "read-only epoch current/floor must not acquire WAL-bearing locks or claim COMMIT phase",
  { timeout: 60_000 },
  async () => {
    const fixture = await pgRuntimeFixture(),
      pool = new Pool({ connectionString: fixture.managementConnectionString, max: 1 }),
      queries: string[] = [];
    const traced = new Proxy(pool, {
      get(target, key) {
        if (key === "connect")
          return async () => {
            const client = await target.connect();
            return new Proxy(client, {
              get(connection, method) {
                if (method === "query")
                  return (sql: string, args?: unknown[]) => {
                    queries.push(sql);
                    return connection.query(sql, args);
                  };
                const value = Reflect.get(connection, method);
                return typeof value === "function" ? value.bind(connection) : value;
              },
            });
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const epochs = pgEpochTransactions(traced);
    let pending: ReturnType<typeof epochs.execute> | undefined;
    try {
      await fixture.adminPool.query(
        "INSERT INTO ha_repo_writer_epochs(repo_id,writer_epoch,writer_holder_id,writer_issued_at) VALUES('epoch-read-probe',1,'holder','2026-11-15T00:00:00.000Z')",
      );
      await strict(fixture, true);
      let done = false;
      let commitGuardCalls = 0;
      const read = (operation: "current" | "floor") =>
        withPostgresCommitGuard(
          async () => {
            commitGuardCalls++;
          },
          () =>
            epochs.execute({
              operation,
              repoId: "epoch-read-probe",
              holderId: "holder",
              now: "2026-11-15T00:00:00.000Z",
            }),
        );
      pending = read("current");
      void pending.then(() => {
        done = true;
      });
      let blocked: { pid: number; usename: string; query: string }[] = [];
      while (!done && !blocked.length)
        blocked = (
          await fixture.adminPool.query(
            "SELECT pid,usename,query FROM pg_stat_activity WHERE wait_event='SyncRep' AND state='active'",
          )
        ).rows;
      console.log("EPOCH_CURRENT_SYNCREP", JSON.stringify({ blocked, queries }));
      assert.deepEqual(
        blocked,
        [],
        "epoch current is a snapshot check; its FOR SHARE/COMMIT must not block backup admission or the next canonical write",
      );
      assert.deepEqual(await pending, {
        repoId: "epoch-read-probe",
        holderId: "holder",
        epoch: 1,
        version: 1,
        issuedAt: "2026-11-15T00:00:00.000Z",
      });
      assert.equal(await read("floor"), 1);
      assert.equal(commitGuardCalls, 0, "snapshot reads must leave the enclosing request's COMMIT phase untouched");
      assert.equal(queries.length, 2);
      assert.ok(queries.every((sql) => sql.startsWith("SELECT ") && !/FOR (?:SHARE|UPDATE)/u.test(sql)));

      const request = { repoId: "epoch-read-probe", holderId: "holder", now: "2026-11-15T00:00:00.000Z", epoch: 1 };
      await epochs.execute({ ...request, operation: "begin" });
      const contender = await fixture.adminPool.connect();
      try {
        await contender.query("BEGIN");
        await assert.rejects(
          contender.query("SELECT * FROM ha_repo_writer_epochs WHERE repo_id='epoch-read-probe' FOR UPDATE NOWAIT"),
          { code: "55P03" },
        );
        await contender.query("ROLLBACK");
        done = false;
        pending = withPostgresCommitGuard(
          async () => {
            commitGuardCalls++;
          },
          () => epochs.execute({ ...request, operation: "end" }),
        );
        void pending.then(() => {
          done = true;
        });
        blocked = [];
        while (!done && !blocked.length)
          blocked = (
            await contender.query(
              "SELECT pid,usename,query FROM pg_stat_activity WHERE wait_event='SyncRep' AND state='active'",
            )
          ).rows;
        console.log("EPOCH_FENCE_SYNCREP", JSON.stringify({ blocked, queries }));
        assert.deepEqual(blocked, [], "releasing the read-only held fence must discard row-lock WAL without SyncRep");
        await pending;
        assert.equal(commitGuardCalls, 0);
        await contender.query("BEGIN");
        await contender.query("SELECT * FROM ha_repo_writer_epochs WHERE repo_id='epoch-read-probe' FOR UPDATE NOWAIT");
        await contender.query("ROLLBACK");
      } finally {
        await contender.query("ROLLBACK");
        contender.release();
      }
    } finally {
      await strict(fixture, false);
      await pending;
      await epochs.close();
      await pool.end();
      await fixture.pool.end();
      await fixture.close();
    }
  },
);

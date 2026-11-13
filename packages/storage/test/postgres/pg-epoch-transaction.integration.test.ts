// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
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
    assert.equal(after, "50ms", "SET LOCAL must revert when the fence transaction commits");
  } finally {
    await authorityPool?.end();
    await fixture.pool.end();
    await fixture.close();
  }
});

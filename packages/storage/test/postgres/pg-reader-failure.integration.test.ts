// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { startManagedPostgresFixture } from "./managed-postgres.fixture.ts";
import { ensurePgProjectionSchema } from "../../src/pg/pg-projection-schema.ts";
import { POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS } from "../../src/postgres/event-ledger-schema.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";

test("query worker failures stay inside the reader and preserve the calling process", async (t) => {
  const fixture = await startManagedPostgresFixture();
  try {
    await withPostgresTransaction(fixture.adminPool, async (client) => {
      for (const statement of POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS) await client.query(statement);
      await ensurePgProjectionSchema(client);
    });
    for (const mode of ["idle", "session", "crash", "exit"])
      await t.test(mode, async () => {
        const { stdout } = await promisify(execFile)(
          process.execPath,
          [
            fileURLToPath(new URL("./pg-reader-failure-child.fixture.ts", import.meta.url)),
            mode,
            `postgres://postgres@127.0.0.1:${fixture.port}/postgres`,
          ],
          { timeout: 30000 },
        );
        const result = JSON.parse(stdout);
        assert.equal(result.alive, true);
        assert.equal(result.mode, mode);
        assert.equal(
          result.code,
          mode === "crash" ? "injected_worker_crash" : mode === "exit" ? "pg_query_worker_exited" : "57P01",
        );
        assert.doesNotMatch(result.message, /timed out/);
        process.stdout.write(`PG_READER_FAILURE ${stdout}\n`);
      });
    const active = await fixture.adminPool.query(
      "SELECT pid FROM pg_stat_activity WHERE application_name LIKE 'reader-failure-%'",
    );
    assert.deepEqual(active.rows, [], "failed readers must release their connections");
  } finally {
    await fixture.close();
  }
});

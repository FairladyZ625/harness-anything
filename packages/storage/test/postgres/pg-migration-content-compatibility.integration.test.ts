// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS } from "../../src/postgres/event-ledger-schema.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { ensurePgProjectionSchema } from "../../src/pg/pg-projection-schema.ts";
import { startManagedPostgresFixture } from "./managed-postgres.fixture.ts";
import { assertContentParity } from "./pg-migration-content-compatibility.fixture.ts";

test("canonical NUL documents retain bytes, queries and headDigest on PostgreSQL", async (t) => {
  await t.test("PostgreSQL", async () => {
    const fixture = await startManagedPostgresFixture();
    try {
      const version = (await fixture.adminPool.query<{ version: string }>("SELECT version() AS version")).rows[0]!
        .version;
      assert.match(version, /^PostgreSQL 18\.3(?:\s|$)/u);
      process.stdout.write(`CONTENT_SERVER PostgreSQL ${version}\n`);
      await withPostgresTransaction(fixture.adminPool, async (client) => {
        for (const statement of POSTGRES_EVENT_LEDGER_SCHEMA_STATEMENTS) await client.query(statement);
        await ensurePgProjectionSchema(client);
      });
      await assertContentParity(fixture.adminPool, "PostgreSQL");
    } finally {
      await fixture.close();
    }
  });
});

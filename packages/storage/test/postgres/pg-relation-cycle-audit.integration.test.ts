// harness-test-tier: integration
import test, { before, after } from "node:test";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";
import { relationCycleAuditCases } from "./relation-cycle-audit.fixture.ts";
import { createPgTaskProjectionSource } from "../../src/pg/pg-task-source.ts";
import { PG_RELATION_CYCLE_TABLES } from "../../src/pg/pg-relation-cycle-audit.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";

let fixture: Awaited<ReturnType<typeof pgRuntimeFixture>>;
before(async () => {
  fixture = await pgRuntimeFixture();
});
after(async () => {
  if (fixture) {
    await fixture.pool.end();
    await fixture.close();
  }
});
for (const [name, run] of Object.entries(
  relationCycleAuditCases(async (_root, scope, repoId) => {
    // Cases use disjoint scopes; cost pairs reopen the same scope on the one managed server.
    await withPostgresTransaction(
      fixture.pool,
      async (client) => {
        for (const table of ["ha_relations", ...PG_RELATION_CYCLE_TABLES])
          await client.query(`DELETE FROM ${table} WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3`, [
            scope.tenantId,
            scope.projectId,
            scope.policyEpoch,
          ]);
      },
      scope,
    );
    return {
      pool: fixture.pool,
      projection: createPgTaskProjectionSource({ pool: fixture.pool, scope, repoId, ownsPool: false }),
      close: async () => {}, // The suite owns the server and closes it after every case has finished.
    };
  }),
))
  test(name, run);

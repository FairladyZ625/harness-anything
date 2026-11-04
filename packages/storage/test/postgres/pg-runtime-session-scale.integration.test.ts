// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { ensurePgProjectionSchema } from "../../src/pg/index.ts";
import { pgRuntimeSessionReadStatement } from "../../src/pg/pg-projection-values.ts";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";
import { explainNodes } from "./pg-explain.fixture.ts";

test("PG unsettled runtime read touches only unsettled rows, not the settled history", async () => {
  const fixture = await pgRuntimeFixture(),
    client = await fixture.adminPool.connect();
  try {
    await ensurePgProjectionSchema(client);
    // A settled history far larger than the two sessions recovery still needs.
    await client.query(
      `INSERT INTO ha_projection_values
        (tenant_id,project_id,policy_epoch,readers,model,entity_id,owner_id,workspace_revision,value)
       SELECT 'tenant','project',0,'{}','runtime-session','runtime-settled-'||g,'',g,
         json_build_object('runtimeSessionId','runtime-settled-'||g,'outcome','succeeded')::text
       FROM generate_series(1,5000) g`,
    );
    await client.query(
      `INSERT INTO ha_projection_values
        (tenant_id,project_id,policy_epoch,readers,model,entity_id,owner_id,workspace_revision,value)
       VALUES
        ('tenant','project',0,'{}','runtime-session','runtime-open-a','',5001,'{"runtimeSessionId":"runtime-open-a","outcome":null}'),
        ('tenant','project',0,'{}','runtime-session','runtime-open-b','',5002,'{"runtimeSessionId":"runtime-open-b","outcome":null}')`,
    );
    await client.query("ANALYZE ha_projection_values");

    const statement = pgRuntimeSessionReadStatement(
        { tenantId: "tenant", projectId: "project", policyEpoch: 0, readers: [] },
        "repo",
        { unsettledOnly: true },
      ),
      explained = await client.query<{ "QUERY PLAN": { Plan: Record<string, unknown> }[] }>(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`,
        [...statement.values],
      ),
      plan = explained.rows[0]!["QUERY PLAN"][0]!.Plan,
      planText = JSON.stringify(plan);
    for (const node of explainNodes(plan).filter((row) => row["Relation Name"] === "ha_projection_values"))
      assert.ok(
        (Number(node["Actual Rows"]) + Number(node["Rows Removed by Filter"] ?? 0)) * Number(node["Actual Loops"]) <= 2,
        `unsettled read examined settled history: ${JSON.stringify(node)}`,
      );
    assert.equal(plan["Actual Rows"], 2, `the read touched history rows: ${planText}`);
  } finally {
    client.release();
    await fixture.pool.end();
    await fixture.close();
  }
});

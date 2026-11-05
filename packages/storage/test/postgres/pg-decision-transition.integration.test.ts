// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";
import { tracedPgReads, explainNodes, reportPgVersion } from "./pg-explain.fixture.ts";
import { createPgTaskProjectionSource } from "../../src/pg/pg-task-source.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { backfillPgDecisionSearchPage } from "../../src/pg/pg-decision-search.ts";
import { finishPgDecisionReadBackfill } from "../../src/pg/pg-decision-read-status.ts";
import { reduceDecisionDocument } from "@harness-anything/kernel/internal/domain/decision-event-document.ts";
import { proposal } from "../store/relation-graph-projection.fixtures.ts";

test("Decision migration refuses lists at constant cost, preserves point reads and resumes indexed pagination", async (t) => {
  const fixture = await pgRuntimeFixture();
  try {
    await reportPgVersion(fixture.pool, "postgres-transition");
    for (const size of [1000, 10000]) {
      const scope = { tenantId: `checkpoint-${size}`, projectId: "checkpoint", policyEpoch: 1 },
        keys = [scope.tenantId, scope.projectId, scope.policyEpoch],
        value = reduceDecisionDocument(null, proposal(1, "dec_template")),
        manage = <T>(run: (client: import("pg").PoolClient) => Promise<T>) =>
          withPostgresTransaction(fixture.adminPool, run, scope);
      await manage(async (client) => {
        await client.query("TRUNCATE ha_decisions,ha_decision_positions,ha_search_terms,ha_decision_read_status");
        await client.query(
          `INSERT INTO ha_decisions(tenant_id,project_id,policy_epoch,decision_id,workspace_revision,value)
           SELECT $1,$2,$3,id,1,$4::jsonb || jsonb_build_object('decisionId',id,'title',
             CASE WHEN n=$5 THEN 'uniquemarker' ELSE 'ordinary' END)
           FROM generate_series(1,$5::integer)n CROSS JOIN LATERAL
             (SELECT CASE WHEN n=$5 THEN 'dec_z_E1' ELSE 'dec_'||lpad(n::text,6,'0') END AS id) ids`,
          [...keys, JSON.stringify(value), size],
        );
        await client.query(
          `INSERT INTO ha_repo_heads(tenant_id,project_id,policy_epoch,repo_id,revision,head_op_id,head_event_digest,head_digest)
           VALUES($1,$2,$3,'checkpoint',1,'fixture','fixture','fixture')`,
          keys,
        );
        await client.query(
          `INSERT INTO ha_projection_meta(tenant_id,project_id,policy_epoch,schema_version,watermark,source_revision)
           VALUES($1,$2,$3,5,1,1)`,
          keys,
        );
        // One remaining scalar owner: all other rows already have stored keys.
        await client.query(
          `UPDATE ha_decisions SET decision_sort_key=NULL,legacy_group=NULL,legacy_number=NULL,decision_state=NULL
           WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND decision_id='dec_z_E1'`,
          keys,
        );
        const page = await backfillPgDecisionSearchPage(client, scope);
        assert.equal(page.processed, 64);
        assert.equal(page.done, false);
        await client.query("ANALYZE ha_decisions");
        await client.query("ANALYZE ha_decision_positions");
        await client.query("ANALYZE ha_search_terms");
      });
      const pending = await manage((client) =>
        client.query(
          `SELECT count(*) FILTER (WHERE decision_sort_key IS NULL)::integer AS scalar,
         count(*) FILTER (WHERE NOT search_ready)::integer AS search
         FROM ha_decisions WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3`,
          keys,
        ),
      );
      assert.deepEqual(pending.rows[0], { scalar: 1, search: size - 64 });
      const plans: unknown[] = [],
        source = createPgTaskProjectionSource({
          pool: tracedPgReads(fixture.pool, plans, (sql) => /^\s*(SELECT|WITH)\b/iu.test(sql)),
          scope,
          repoId: "checkpoint",
          ownsPool: false,
        });
      const pendingRead = async (read: () => Promise<unknown>, label: string) => {
        plans.length = 0;
        await assert.rejects(read(), {
          code: "projection_pending",
          message: /migration is not ready.*progress generation=.*Retry/u,
        });
        const nodes = explainNodes(plans).filter((node) => typeof node["Relation Name"] === "string");
        const scanned = nodes.reduce(
          (sum, node) =>
            sum +
            Math.max(
              Number(node["Heap Fetches"] ?? 0),
              Number(node["Actual Rows"]) +
                Number(node["Rows Removed by Filter"] ?? 0) +
                Number(node["Rows Removed by Index Recheck"] ?? 0),
            ) *
              Number(node["Actual Loops"]),
          0,
        );
        t.diagnostic(`PENDING_BUDGET ${JSON.stringify({ size, label, scanned })}`);
        assert.ok(scanned <= 4, `pending request inspected ${scanned} rows`);
        assert.equal(
          nodes.some((node) => node["Relation Name"] === "ha_decisions"),
          false,
          "an initialized summary must not visit Decision history",
        );
      };
      for (const search of [undefined, "uniquemarker", "absentmarker"])
        await pendingRead(() => source.listDecisions({ limit: 1, ...(search ? { search } : {}) }), search ?? "scalar");
      await pendingRead(() => source.listDecisionAgendaPage({ state: "proposed", limit: 1 }), "agenda");
      assert.equal((await source.readDecision("dec_z_E1", false)).decision?.decisionId, "dec_z_E1");
      assert.equal((await source.readCut()).status, "ready");
      // Complete only scalar backfill first: search remains explicitly unavailable.
      await manage(async (client) => {
        const result = await client.query("SELECT ha_backfill_decision_indexes($1,$2,$3) AS processed", keys);
        assert.equal(result.rows[0]!.processed, 1);
        await finishPgDecisionReadBackfill(client, scope);
        await client.query("ANALYZE ha_decisions");
      });
      plans.length = 0;
      const first = await source.listDecisions({ limit: 1 });
      assert.equal(first.decisions[0]!.decisionId, "dec_z_E1");
      const scans = explainNodes(plans).filter((n) => n["Relation Name"] === "ha_decisions");
      const scanned = scans.reduce(
        (sum, n) =>
          sum +
          Math.max(
            Number(n["Heap Fetches"] ?? 0),
            Number(n["Actual Rows"]) + Number(n["Rows Removed by Filter"] ?? 0),
          ) *
            Number(n["Actual Loops"]),
        0,
      );
      t.diagnostic(`READY_BUDGET ${JSON.stringify({ size, scanned })}`);
      assert.ok(scanned <= 4);
      assert.equal(
        (await source.listDecisions({ limit: 1, cursor: first.page!.nextCursor! })).decisions[0]!.decisionId,
        "dec_000001",
      );
      await pendingRead(() => source.listDecisions({ search: "absentmarker", limit: 1 }), "search-only");
      let processed = 64;
      for (let turn = 0; ; turn++) {
        assert.ok(turn <= Math.ceil(size / 64) + 2);
        const page = await manage((client) => backfillPgDecisionSearchPage(client, scope));
        assert.ok(page.processed <= 64);
        processed += page.processed;
        if (page.done) break;
      }
      assert.equal(processed, size, "resume skips the first committed search page");
      assert.deepEqual(
        (await source.listDecisions({ search: "uniquemarker", limit: 1 })).decisions.map((d) => d.decisionId),
        ["dec_z_E1"],
      );
      assert.deepEqual((await source.listDecisions({ search: "absentmarker", limit: 1 })).decisions, []);
      assert.equal(
        (await source.listDecisionAgendaPage({ state: "proposed", limit: 1 })).decisions[0]!.decisionId,
        "dec_000001",
      );
    }
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});

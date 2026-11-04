// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { proposal, accepted, actor, relation } from "../store/relation-graph-projection.fixtures.ts";
import { reduceDecisionDocument } from "@harness-anything/kernel/internal/domain/decision-event-document.ts";
import { reduceRelationEntity } from "@harness-anything/kernel/internal/domain/relation-event.ts";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";
import { refreshPgDecisionSearch } from "../../src/pg/pg-decision-search.ts";
import { PG_PROJECTION_SCHEMA_VERSION } from "../../src/pg/pg-projection-schema.ts";
import { createPgTaskProjectionSource } from "../../src/pg/pg-task-source.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { tracedPgReads, explainNodes, reportPgVersion } from "./pg-explain.fixture.ts";

test("typed-core ready-cut result budgets at 100001 rows", async (t) => {
  const fixture = await pgRuntimeFixture(),
    scope = { tenantId: "typed-budget", projectId: "typed-budget", policyEpoch: 1 },
    proposed = reduceDecisionDocument(null, proposal(1, "dec_template")),
    inEffect = reduceDecisionDocument(proposed, accepted(2, "dec_template"));
  try {
    await reportPgVersion(fixture.pool, "postgres");
    await withPostgresTransaction(
      fixture.adminPool,
      async (client) => {
        await client.query(
          `INSERT INTO ha_decisions
        (tenant_id,project_id,policy_epoch,decision_id,workspace_revision,value)
        SELECT $1,$2,$3,'dec_'||lpad(n::text,6,'0'),CASE WHEN n=100001 THEN 1 ELSE 2 END,
          (CASE WHEN n=100001 THEN $4::jsonb ELSE $5::jsonb END)
          || jsonb_build_object('decisionId','dec_'||lpad(n::text,6,'0'),
             'title',CASE WHEN n=100001 THEN 'uniquemarker alpha needle' ELSE 'historical alpha gap needle' END)
          FROM generate_series(1,100001)n`,
          [scope.tenantId, scope.projectId, scope.policyEpoch, JSON.stringify(proposed), JSON.stringify(inEffect)],
        );
        await client.query(
          `INSERT INTO ha_repo_heads
        (tenant_id,project_id,policy_epoch,repo_id,revision,head_op_id,head_event_digest,head_digest)
        VALUES($1,$2,$3,'typed-budget',100001,'fixture','fixture','fixture')`,
          [scope.tenantId, scope.projectId, scope.policyEpoch],
        );
        await client.query(
          `INSERT INTO ha_projection_meta
        (tenant_id,project_id,policy_epoch,schema_version,watermark,source_revision)
        VALUES($1,$2,$3,$4,100001,100001)`,
          [scope.tenantId, scope.projectId, scope.policyEpoch, PG_PROJECTION_SCHEMA_VERSION],
        );
        // All historical documents have identical searchable fields. Derive their
        // positional template with the real writer, then bulk-copy that exact fixture.
        await refreshPgDecisionSearch(client, scope, "dec_000001");
        await refreshPgDecisionSearch(client, scope, "dec_100001");
        await client.query(
          `INSERT INTO ha_decision_positions
          (tenant_id,project_id,policy_epoch,readers,term_key,term_slot,decision_id,column_id,position,repo_id,head_readers,blob_readers)
          SELECT p.tenant_id,p.project_id,p.policy_epoch,p.readers,p.term_key,p.term_slot,'dec_'||lpad(n::text,6,'0'),
            p.column_id,p.position,p.repo_id,p.head_readers,p.blob_readers
          FROM ha_decision_positions p CROSS JOIN generate_series(2,100000)n
          WHERE p.tenant_id=$1 AND p.project_id=$2 AND p.policy_epoch=$3 AND p.decision_id='dec_000001'`,
          [scope.tenantId, scope.projectId, scope.policyEpoch],
        );
        await client.query(
          "UPDATE ha_decisions SET search_ready=true WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3",
          [scope.tenantId, scope.projectId, scope.policyEpoch],
        );
        await client.query("ANALYZE ha_decision_positions");
        await client.query("ANALYZE ha_search_terms");
        await client.query("ANALYZE ha_decisions");
      },
      scope,
    );
    const plans: unknown[] = [],
      source = createPgTaskProjectionSource({
        pool: tracedPgReads(
          fixture.pool,
          plans,
          (sql) =>
            sql.includes("FROM ha_decisions") ||
            sql.includes("FROM ha_relations") ||
            sql.includes("ha_decision_positions"),
        ),
        scope,
        repoId: "typed-budget",
        ownsPool: false,
      });
    const assertBudget = (method: string, table: string, returned: number) => {
      const scans = explainNodes(plans).filter((row) => row["Relation Name"] === table),
        scanned = scans.reduce(
          (total, row) =>
            total +
            (Number(row["Actual Rows"]) +
              Number(row["Rows Removed by Filter"] ?? 0) +
              Number(row["Rows Removed by Index Recheck"] ?? 0)) *
              Number(row["Actual Loops"]),
          0,
        );
      process.stdout.write(`TYPED_BUDGET ${JSON.stringify({ method, returned, scanned, scale: 100001 })}\n`);
      assert.ok(scans.length > 0, "must observe the production SQL");
      assert.ok(scanned <= 2, `${method} returns ${returned} but scans ${scanned}`);
    };
    await t.test("state-filtered decision page", async () => {
      plans.length = 0;
      const result = await source.listDecisions({ state: "proposed", limit: 1 });
      assert.equal(result.status, "ready");
      assert.equal(result.watermark, 100001);
      assert.equal(result.sourceRevision, 100001);
      assert.deepEqual(
        result.decisions.map((row) => row.decisionId),
        ["dec_100001"],
      );
      assertBudget("listDecisions(state=proposed,limit=1)", "ha_decisions", result.decisions.length);
    });
    await t.test("literal full-text decision page", async () => {
      plans.length = 0;
      const result = await source.listDecisions({ search: "uniquemarker", limit: 1 });
      assert.equal(result.status, "ready");
      assert.deepEqual(
        result.decisions.map((row) => row.decisionId),
        ["dec_100001"],
      );
      assertBudget("listDecisions(search,limit=1)", "ha_decisions", result.decisions.length);
    });
    await t.test("high-frequency phrase reads only its token postings", async () => {
      plans.length = 0;
      const result = await source.listDecisions({ search: "alpha needle", limit: 1 });
      assert.deepEqual(
        result.decisions.map((r) => r.decisionId),
        ["dec_100001"],
      );
      assertBudget("listDecisions(high-frequency phrase,limit=1)", "ha_decisions", 1);
      const scanned = explainNodes(plans)
        .filter((node) => node["Relation Name"] === "ha_decision_positions")
        .reduce(
          (sum, node) =>
            sum +
            (Number(node["Actual Rows"]) +
              Number(node["Rows Removed by Filter"] ?? 0) +
              Number(node["Rows Removed by Index Recheck"] ?? 0)) *
              Number(node["Actual Loops"]),
          0,
        );
      process.stdout.write(
        `POSITION_BUDGET ${JSON.stringify({ queryTokens: 2, postings: 200002, scanned, returned: 1 })}\n`,
      );
      assert.ok(scanned <= 200002, `query has 200002 token postings but scans ${scanned}`);
    });
    await t.test("freshness-filtered relation page", async () => {
      const entities = Array.from({ length: 100001 }, (_, index) => {
        const { strength: _strength, ...record } = relation({
          source: "task/task_seed",
          target: `person/p_${index}`,
          type: "assigned-to",
        });
        return reduceRelationEntity(null, {
          schema: "relation-event/v1",
          eventId: `r-${index}`,
          opId: `r-${index}`,
          workspaceRevision: index + 1,
          relationId: record.relation_id,
          type: "relation_created",
          actor,
          source: "local",
          occurredAt: "2026-11-05T00:00:00.000Z",
          payload: { relation: { ...record, targetObservedVersion: `keycloak-user:p_${index}:stable` } },
        });
      }).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const last = entities.at(-1)!;
      entities[entities.length - 1] = { ...last, targetObservedVersion: null };
      await withPostgresTransaction(
        fixture.adminPool,
        async (client) => {
          for (let start = 0; start < entities.length; start += 2000)
            await client.query(
              `INSERT INTO ha_relations
            (tenant_id,project_id,policy_epoch,relation_id,source_ref,target_ref,relation_type,relation_state,workspace_revision,value)
            SELECT $1,$2,$3,v->>'id',v->>'source',v->>'target',v->>'type',v->>'state',(v->>'revision')::bigint,
              v||jsonb_build_object('sourcePath','event:fixture','recordIndex',0)
              FROM jsonb_array_elements($4::jsonb) v`,
              [scope.tenantId, scope.projectId, scope.policyEpoch, JSON.stringify(entities.slice(start, start + 2000))],
            );
          await client.query("ANALYZE ha_relations");
        },
        scope,
      );
      plans.length = 0;
      const result = await source.readRelationQuery({ freshness: "suspect", limit: 1 });
      assert.equal(result.status, "ready");
      assert.deepEqual(
        result.rows.map((row) => row.relationId),
        [last.id],
      );
      assert.equal(result.page!.nextCursor, null);
      assertBudget("readRelationQuery(freshness=suspect,limit=1)", "ha_relations", result.rows.length);
    });
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});

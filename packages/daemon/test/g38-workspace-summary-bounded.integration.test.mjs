// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { blockingOf, isDomainStatus, summarizeWorkspace, workspaceTaskStatus } from "@harness-anything/kernel";
import { createPGliteStorageBackend } from "../../storage/src/pglite/storage-backend.ts";
import { pgliteIntegrationSuite } from "../../storage/test/pglite/pglite-runtime.fixture.ts";
import { pgAggregateQueries } from "../../storage/src/pg/pg-aggregate-queries.ts";
import { readRelationsInTransaction } from "../../storage/src/pg/pg-relation-queries.ts";
import { withPostgresTransaction } from "../../storage/src/postgres/transaction.ts";
import { READ_MARGINS, READ_SCALES, evaluateReadMeasurements } from "../../../tools/gates/cost-budget-reads.mjs";
import { READ_PROBES, measureReadScale } from "./fixtures/g38-read-cost.mjs";

const scope = { tenantId: "summary", projectId: "parity", policyEpoch: 0 };

// Frozen pre-fix algorithm: every visible task/relation, including archived endpoints.
async function legacySummary(pool, claims) {
  return withPostgresTransaction(
    pool,
    async (client) => {
      const parameters = [claims.tenantId, claims.projectId, claims.policyEpoch, claims.readers ?? []];
      const tasks = (
        await client.query(
          `SELECT task_id,snapshot#>>'{task,status}' AS status,
         COALESCE(snapshot#>>'{task,packageDisposition}','active') AS disposition,updated_at
       FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
         AND (cardinality($4::text[])=0 OR readers && $4::text[]) ORDER BY task_id`,
          parameters,
        )
      ).rows;
      const relations = await readRelationsInTransaction(client, claims, claims.readers ?? [], {});
      const states = new Map(
        blockingOf(
          tasks.map(({ task_id, status }) => ({ taskId: task_id, status: status ?? "unknown" })),
          relations,
        ).map(({ taskId, state }) => [taskId, state]),
      );
      const decisions = (
        await client.query(
          `SELECT decision_id,value->>'state' AS state FROM ha_decisions
       WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3
         AND (cardinality($4::text[])=0 OR readers && $4::text[]) ORDER BY decision_id`,
          parameters,
        )
      ).rows;
      return summarizeWorkspace(
        tasks.map((row) => ({
          coordinationStatus:
            row.status !== null && isDomainStatus(row.status)
              ? workspaceTaskStatus({ status: row.status, blockingState: states.get(row.task_id) ?? "unknown" })
              : "unknown",
          packageDisposition: row.disposition,
          updatedAt: row.updated_at.toISOString(),
        })),
        decisions.map(({ decision_id, state }) => ({ decisionId: decision_id, state })),
      );
    },
    claims,
    { isolationLevel: "repeatable read" },
  );
}

// Full-scale evidence fails closed on an unsupported runtime; ordinary Node 24 CI
// uses the repository's canonical refusal contract, and Node 26 runs the database cases.
if (process.env.FLEET_STRESS_G38_READ_SCALES === "1")
  assert.ok(Number(process.versions.node.split(".")[0]) >= 26, "full-scale PGlite evidence requires Node 26");

pgliteIntegrationSuite("bounded PG workspace summary", () => {
  test("PG bounded summary equals the legacy census across statuses, ACLs and blocking components", async () => {
    const backend = await createPGliteStorageBackend({ repoId: "summary", storage: { backend: "pglite", scope } });
    try {
      const task = async (id, status, disposition, readers = ["one", "two"], updatedAt = "2026-10-01T00:00:00Z") => {
        await backend.pool.query(
          `INSERT INTO ha_task_snapshots(tenant_id,project_id,policy_epoch,readers,task_id,workspace_revision,snapshot,updated_at)
         VALUES ('summary','parity',0,$1,$2,1,$3,$4)`,
          [
            readers,
            id,
            { task: { taskId: id, status, ...(disposition ? { packageDisposition: disposition } : {}) } },
            updatedAt,
          ],
        );
      };
      let serial = 0;
      const edge = async (source, target, extra = {}) => {
        const {
          type = "depends-on",
          state = "active",
          strength = "strong",
          freshness = "current",
          direction = "directed",
          rationale = "",
          readers = ["one", "two"],
        } = extra;
        const id = extra.id ?? `relation-${serial++}`;
        await backend.pool.query(
          `INSERT INTO ha_relations(tenant_id,project_id,policy_epoch,readers,relation_id,source_ref,target_ref,
           relation_type,relation_state,workspace_revision,value,freshness)
         VALUES ('summary','parity',0,$1,$2,$3,$4,$5,$6,1,$7,$8)`,
          [
            readers,
            id,
            source,
            target,
            type,
            state,
            {
              id,
              source,
              target,
              type,
              state,
              strength,
              direction,
              rationale,
              origin: "declared",
              sourcePath: "fixture",
              recordIndex: 0,
            },
            freshness,
          ],
        );
      };
      assert.deepEqual(
        (await pgAggregateQueries({ pool: backend.pool, scope, repoId: "summary" }).readWorkspaceSummary()).summary,
        await legacySummary(backend.pool, scope),
      );
      for (const status of [
        "planned",
        "active",
        "submitted",
        "blocked",
        "in_review",
        "done",
        "cancelled",
        "unmapped",
        null,
      ]) {
        await task(`status-${status}`, status);
        await task(`archived-${status}`, status, "archived", ["one", "two"], "2026-12-01T00:00:00Z");
        await edge(`task/status-${status}`, "person/operator", { type: "awaits", rationale: "question: Ready?" });
      }
      for (const id of [
        "waiting",
        "missing",
        "cycle",
        "self",
        "done-cycle",
        "retired",
        "stale",
        "weak",
        "hidden-target",
        "hidden-edge",
        "diamond",
      ])
        await task(id, "planned", "active");
      await task("bridge", "active", "archived");
      await task("cycle-done", "done", "archived");
      await task("unfinished", "active", "archived");
      await task("invisible", "active", "archived", ["two"]);
      await task("hidden-current", "active", "active", ["two"], "2026-11-02T00:00:00Z");
      await edge("task/waiting", "task/unfinished");
      await edge("task/missing", "task/absent");
      await edge("task/cycle", "task/bridge");
      await edge("task/bridge", "task/cycle");
      await edge("task/self", "task/self");
      await edge("task/done-cycle", "task/cycle-done");
      await edge("task/cycle-done", "task/done-cycle");
      await edge("task/retired", "task/unfinished", { state: "retired" });
      await edge("task/stale", "task/unfinished", { freshness: "suspect" });
      await edge("task/weak", "task/unfinished", { strength: "weak", freshness: "suspect" });
      await edge("task/hidden-target", "task/invisible");
      await edge("task/hidden-edge", "task/unfinished", { readers: ["two"] });
      await edge("task/diamond", "task/bridge");
      await edge("task/diamond", "task/cycle-done");
      await edge("task/status-done", "task/waiting");
      await edge("task/status-active", "person/operator", { type: "awaits", rationale: "malformed" });
      // blockingOf's DFS order is part of the legacy census contract. An archived
      // incoming entry can visit a done-node cycle before the current seed gets visited.
      for (const id of ["order-entry", "order-a", "order-b"]) await task(id, "done", "archived");
      await task("order-current", "planned", "active");
      for (const [index, source, target] of [
        [0, "order-entry", "order-a"],
        [1, "order-current", "order-b"],
        [2, "order-a", "order-b"],
        [3, "order-a", "order-current"],
        [4, "order-b", "order-a"],
      ])
        await edge(`task/${source}`, `task/${target}`, { id: `000-order-${index}` });
      for (const [index, state] of [
        "proposed",
        "in_effect",
        "rejected",
        "deferred",
        "superseded",
        "outcome_retired",
      ].entries())
        await backend.pool.query(
          `INSERT INTO ha_decisions(tenant_id,project_id,policy_epoch,readers,decision_id,workspace_revision,value)
         VALUES ('summary','parity',0,$1,$2,1,$3)`,
          [index % 2 ? ["two"] : ["one", "two"], `dec_${index}`, { state }],
        );
      // Noise in another scope must not enter either the census or the graph.
      await backend.pool
        .query(`INSERT INTO ha_task_snapshots(tenant_id,project_id,policy_epoch,task_id,workspace_revision,snapshot)
      VALUES ('other','parity',0,'outside',1,'{"task":{"status":"active"}}')`);
      for (const readers of [[], ["one"], ["two"], ["one", "two"], ["nobody"]]) {
        const claims = { ...scope, readers };
        const actual = (
          await pgAggregateQueries({ pool: backend.pool, scope: claims, repoId: "summary" }).readWorkspaceSummary()
        ).summary;
        assert.deepEqual(actual, await legacySummary(backend.pool, claims), JSON.stringify(readers));
        assert.equal(
          actual.tasks.lastChangedAt,
          readers.includes("two") || readers.length === 0
            ? "2026-11-02T00:00:00.000Z"
            : readers.includes("one")
              ? "2026-10-01T00:00:00.000Z"
              : null,
        );
      }
      await backend.pool.query(
        "UPDATE ha_task_snapshots SET snapshot=jsonb_set(snapshot,'{task,packageDisposition}','\"archived\"')",
      );
      const archived = (
        await pgAggregateQueries({ pool: backend.pool, scope, repoId: "summary" }).readWorkspaceSummary()
      ).summary;
      assert.deepEqual(archived, await legacySummary(backend.pool, scope));
      assert.equal(archived.tasks.lastChangedAt, null);
    } finally {
      await backend.close();
    }
  });

  for (const dimension of ["task-history", "runtime-sessions", "dispatches", "relations"])
    test(`G38 workspace-summary is bounded with unrelated ${dimension}`, async (t) => {
      const full = process.env.FLEET_STRESS_G38_READ_SCALES === "1";
      const scales = READ_SCALES;
      const pair = {};
      for (const [scale, size] of Object.entries(scales))
        pair[scale] = (await measureReadScale("pglite", dimension, size, { probeIds: ["workspace-summary"] }))[
          "workspace-summary"
        ];
      t.diagnostic(JSON.stringify({ g38WorkspaceSummary: { dimension, scales, pair } }));
      assert.equal(pair.small.resultSize, pair.large.resultSize);
      for (const phase of ["counts", "firstCall"])
        for (const [metric, margin] of Object.entries(READ_MARGINS))
          assert.ok(
            pair.large[phase][metric] <= pair.small[phase][metric] + margin,
            `${dimension}/${phase}/${metric}: ${pair.small[phase][metric]} -> ${pair.large[phase][metric]}, margin ${margin}`,
          );
      if (full) {
        const section = JSON.parse(
          readFileSync(new URL("../../../tools/gates/cost-budget.json", import.meta.url)),
        ).readCostScaling;
        const selected = {
          ...section,
          readCoverage: {
            measured: { "method:repo.workspace.summary.read": { measurements: ["workspace-summary"] } },
            notApplicable: [],
          },
          knownScaling: section.knownScaling
            .filter((entry) => entry.probe === "workspace-summary" && entry.dimension === dimension)
            .map(({ measurementScales: _bounded, ...entry }) => entry),
        };
        const result = evaluateReadMeasurements({
          section: selected,
          inventory: [{ id: "method:repo.workspace.summary.read" }],
          probes: { "workspace-summary": READ_PROBES["workspace-summary"] },
          measured: { pglite: { [dimension]: { "workspace-summary": pair } } },
          dimensions: [dimension],
          backends: ["pglite"],
        });
        t.diagnostic(JSON.stringify({ exemptionAudit: result.errors }));
        assert.equal(result.ok, true, result.errors.join("\n"));
      }
    });
});

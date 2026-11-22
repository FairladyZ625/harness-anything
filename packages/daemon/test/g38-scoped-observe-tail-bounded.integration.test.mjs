// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pg from "pg";
import { canonicalEventEntityRefs, sha256Text } from "@harness-anything/kernel";
import { serializeCanonicalEventUnchecked } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { compileFactWrite } from "@harness-anything/kernel/internal/domain/fact-event.ts";
import { createPgStorageBackend } from "../../storage/src/pg/backend.ts";
import { createPgTaskQueryReader } from "../../storage/src/pg/pg-task-query-reader.ts";
import { rebuildPgProjection } from "../../storage/src/pg/pg-task-event-materialize.ts";
import { withPostgresTransaction } from "../../storage/src/postgres/transaction.ts";
import { pgRuntimeFixture } from "../../storage/test/postgres/pg-runtime.fixture.ts";
import { fact } from "../../storage/test/store/relation-graph-projection.fixtures.ts";
import { initRepo } from "../../storage/test/store/task-event-store.fixtures.ts";
import { readObserveEventTail } from "../src/daemon-host/observe-tail.ts";
import { planRowsRead } from "./fixtures/g38-read-probe.mjs";

function collectScanNodes(plan, nodes = []) {
  if (/Scan$/u.test(plan["Node Type"] ?? "")) {
    nodes.push({
      nodeType: plan["Node Type"],
      relationName: plan["Relation Name"] ?? null,
      indexName: plan["Index Name"] ?? null,
      actualRows: plan["Actual Rows"] ?? 0,
      actualLoops: plan["Actual Loops"] ?? 1,
      rowsRemovedByFilter: plan["Rows Removed by Filter"] ?? 0,
    });
  }
  for (const child of plan.Plans ?? []) collectScanNodes(child, nodes);
  return nodes;
}

test(
  "F16: PostgreSQL scoped observe.tail (scopePersonId & filterNodeId) bounds scan to 500-revision window with advancing cursors and flat EXPLAIN rows across 4x non-matching history growth",
  { timeout: 180_000 },
  async () => {
    const pgFixture = await pgRuntimeFixture();
    const measureScopedWindow = async (nonMatchingCount) => {
      const rootDir = mkdtempSync(path.join(tmpdir(), `ha-pg-f16-scoped-${nonMatchingCount}-`)),
        repoId = `repo_pg_f16_scoped_${nonMatchingCount}`,
        visibleReader = "reader:visible",
        hiddenReader = "reader:hidden",
        fence = { repoId, holderId: "f16-scoped-writer", epoch: 1 },
        scope = {
          tenantId: "tenant_f16_scoped",
          projectId: `project_f16_scoped_${nonMatchingCount}`,
          policyEpoch: 1,
          readers: [visibleReader],
        };
      let pgReader;
      const originalQuery = pg.Client.prototype.query;
      try {
        initRepo(rootDir);
        const backend = createPgStorageBackend({ pool: pgFixture.pool, scope, repoId }),
          baseEvents = [],
          blobs = new Map(),
          eventReaders = new Map();
        let rev = 0;
        const makeFactBundle = (index, personId, source) => {
          rev += 1;
          const draft = fact(rev),
            sec = rev % 60,
            min = Math.floor(rev / 60) % 60,
            hr = Math.floor(rev / 3600) % 24,
            occurredAt = `2026-11-10T${String(hr).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.000Z`,
            compiled = compileFactWrite({
              event: {
                ...draft,
                factId: `F-${String(index).padStart(8, "0")}`,
                opId: `op-f16-scoped-${rev}`,
                eventId: `ev-f16-scoped-${rev}`,
                occurredAt,
                actor: { principal: { personId }, executor: null },
                source,
                payload: {
                  ...draft.payload,
                  statement: `f16-scoped-${personId}-${index}`,
                  evidenceSource: "f16-scoped-test",
                },
              },
            });
          for (const blob of compiled.blobs) blobs.set(blob.sha256, Buffer.from(blob.body));
          return compiled;
        };

        // 3 early target events for person-target on edge-target (revisions 1..3)
        const firstBundle = makeFactBundle(1, "person-target", { kind: "node", nodeId: "edge-target" });
        await backend.eventStore.append(firstBundle, 0, fence);
        baseEvents.push(firstBundle.event);
        eventReaders.set(firstBundle.event.workspaceRevision, [visibleReader]);
        const expectedTarget = [firstBundle.event.workspaceRevision];
        for (let i = 2; i <= 3; i += 1) {
          const compiled = makeFactBundle(i, "person-target", { kind: "node", nodeId: "edge-target" });
          baseEvents.push(compiled.event);
          eventReaders.set(compiled.event.workspaceRevision, [visibleReader]);
          expectedTarget.push(compiled.event.workspaceRevision);
        }

        // Followed by `nonMatchingCount` events (mix of person-other visible + person-target RLS-hidden)
        for (let i = 0; i < nonMatchingCount; i += 1) {
          const isHiddenTarget = i % 2 === 1,
            compiled = makeFactBundle(
              10_000 + i,
              isHiddenTarget ? "person-target" : "person-other",
              isHiddenTarget ? { kind: "node", nodeId: "edge-target" } : { kind: "node", nodeId: "edge-other" },
            );
          baseEvents.push(compiled.event);
          eventReaders.set(compiled.event.workspaceRevision, [isHiddenTarget ? hiddenReader : visibleReader]);
        }
        const headRev = rev;

        await withPostgresTransaction(
          pgFixture.pool,
          async (client) => {
            for (const [sha, bytes] of blobs) {
              await client.query(
                `INSERT INTO ha_content_blobs (tenant_id,project_id,sha256,size,body,readers,policy_epoch)
                 VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id,project_id,sha256) DO NOTHING`,
                [
                  scope.tenantId,
                  scope.projectId,
                  sha,
                  bytes.byteLength,
                  bytes,
                  [visibleReader, hiddenReader],
                  scope.policyEpoch,
                ],
              );
            }
            for (const raw of baseEvents.slice(1)) {
              const body = serializeCanonicalEventUnchecked(raw).trimEnd();
              await client.query(
                `INSERT INTO ha_events(tenant_id,project_id,repo_id,revision,op_id,event_id,event_type,event_json,event_digest,occurred_at,policy_epoch,readers,entity_refs,actor_refs)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
                [
                  scope.tenantId,
                  scope.projectId,
                  repoId,
                  raw.workspaceRevision,
                  raw.opId,
                  raw.eventId,
                  raw.type,
                  body,
                  `sha256:${sha256Text(body)}`,
                  raw.occurredAt,
                  scope.policyEpoch,
                  eventReaders.get(raw.workspaceRevision),
                  canonicalEventEntityRefs(raw),
                  [raw.actor.principal.personId, ...(raw.actor.executor ? [raw.actor.executor.id] : [])],
                ],
              );
            }
            await client.query(
              "UPDATE ha_repo_heads SET revision=$5, head_op_id=$6 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4",
              [scope.tenantId, scope.projectId, scope.policyEpoch, repoId, headRev, baseEvents.at(-1).opId],
            );
            await rebuildPgProjection(client, scope, {
              events: baseEvents,
              sourceRevision: headRev,
              readContentBlob: (sha) => blobs.get(sha) ?? null,
            });
          },
          { ...scope, readers: [visibleReader, hiddenReader] },
        );
        await pgFixture.adminPool.query("ANALYZE ha_events");

        const plans = [];
        let capturing = false;
        pg.Client.prototype.query = function (...args) {
          const promise = originalQuery.apply(this, args);
          const sql = typeof args[0] === "string" ? args[0] : (args[0]?.text ?? "");
          if (!capturing || !sql.includes("SELECT event.list_row FROM")) return promise;
          return promise.then(async (res) => {
            const explained = await originalQuery.call(
                this,
                `EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF) ${sql}`,
                args[1],
              ),
              plan = explained.rows[0]["QUERY PLAN"][0].Plan;
            plans.push({
              rowsRead: planRowsRead(plan),
              scanNodes: collectScanNodes(plan),
            });
            return res;
          });
        };

        pgReader = createPgTaskQueryReader({ connectionString: pgFixture.connectionString, scope, repoId });
        const recoveredPersonHistory = [],
          recoveredPersonFollow = [],
          recoveredNodeHistory = [];
        let firstPersonHistory, firstPersonFollow;

        pgReader.withSession((pgQueries) => {
          // 1. Positive: scopePersonId history steps cleanly across >500-revision sparse gap
          firstPersonHistory = readObserveEventTail({
            repoId,
            rootDir,
            mode: "local",
            projection: pgQueries,
            payload: { kind: "events", direction: "history", scopePersonId: "person-target" },
          });
          assert.equal(firstPersonHistory.done, false);
          assert.equal(firstPersonHistory.items.length, 0);
          assert.ok(firstPersonHistory.historyCursor.revision > 0);
          recoveredPersonHistory.push(...firstPersonHistory.items.map((item) => item.workspaceRevision));
          let hPage = firstPersonHistory;
          let steps = 0;
          while (!hPage.done) {
            steps += 1;
            assert.ok(steps <= 20, "history cursor must advance and terminate");
            hPage = readObserveEventTail({
              repoId,
              rootDir,
              mode: "local",
              projection: pgQueries,
              payload: {
                kind: "events",
                direction: "history",
                scopePersonId: "person-target",
                cursor: hPage.historyCursor,
              },
            });
            recoveredPersonHistory.unshift(...hPage.items.map((item) => item.workspaceRevision));
          }

          // 2. Positive: scopePersonId follow steps cleanly across >500-revision sparse gap to headRev
          firstPersonFollow = readObserveEventTail({
            repoId,
            rootDir,
            mode: "local",
            projection: pgQueries,
            payload: {
              kind: "events",
              direction: "follow",
              scopePersonId: "person-target",
              cursor: { kind: "events", revision: 0 },
            },
          });
          assert.equal(firstPersonFollow.done, false);
          recoveredPersonFollow.push(...firstPersonFollow.items.map((item) => item.workspaceRevision));
          let fPage = firstPersonFollow;
          steps = 0;
          while (!fPage.done) {
            steps += 1;
            assert.ok(steps <= 20, "follow cursor must advance and terminate");
            fPage = readObserveEventTail({
              repoId,
              rootDir,
              mode: "local",
              projection: pgQueries,
              payload: {
                kind: "events",
                direction: "follow",
                scopePersonId: "person-target",
                cursor: fPage.liveCursor,
              },
            });
            recoveredPersonFollow.push(...fPage.items.map((item) => item.workspaceRevision));
          }
          assert.equal(fPage.liveCursor.revision, headRev);

          // 3. Positive: filterNodeId history also steps cleanly and recovers target events
          let nPage = readObserveEventTail({
            repoId,
            rootDir,
            mode: "local",
            projection: pgQueries,
            payload: { kind: "events", direction: "history", filterNodeId: "edge-target" },
          });
          recoveredNodeHistory.push(...nPage.items.map((item) => item.workspaceRevision));
          while (!nPage.done) {
            nPage = readObserveEventTail({
              repoId,
              rootDir,
              mode: "local",
              projection: pgQueries,
              payload: {
                kind: "events",
                direction: "history",
                filterNodeId: "edge-target",
                cursor: nPage.historyCursor,
              },
            });
            recoveredNodeHistory.unshift(...nPage.items.map((item) => item.workspaceRevision));
          }

          // 4. Negative: nonexistent scopePersonId returns empty items cleanly & invalid cursor rejects
          const emptyPage = readObserveEventTail({
            repoId,
            rootDir,
            mode: "local",
            projection: pgQueries,
            payload: { kind: "events", direction: "history", scopePersonId: "person-unknown" },
          });
          assert.deepEqual(emptyPage.items, []);
          assert.equal(emptyPage.done, false);
          assert.throws(
            () =>
              readObserveEventTail({
                repoId,
                rootDir,
                mode: "local",
                projection: pgQueries,
                payload: {
                  kind: "events",
                  direction: "follow",
                  scopePersonId: "person-target",
                  cursor: { kind: "events", revision: headRev + 10 },
                },
              }),
            (error) => error?.code === "invalid_cursor",
          );
        });

        // Capture real PostgreSQL EXPLAIN (ANALYZE, FORMAT JSON) on bounded person & node queries!
        capturing = true;
        await backend.projection.readEventList({
          actorPersonId: "person-target",
          afterRevision: Math.max(0, headRev - 500),
          revisionBound: headRev + 1,
          order: "desc",
          limit: 64,
        });
        await backend.projection.readEventList({
          nodeId: "edge-target",
          afterRevision: Math.max(0, headRev - 500),
          revisionBound: headRev + 1,
          order: "desc",
          limit: 64,
        });
        capturing = false;

        assert.deepEqual(recoveredPersonHistory, expectedTarget);
        assert.deepEqual(recoveredPersonFollow, expectedTarget);
        assert.deepEqual(recoveredNodeHistory, expectedTarget);
        assert.equal(plans.length, 2);
        return { personPlan: plans[0], nodePlan: plans[1] };
      } finally {
        pg.Client.prototype.query = originalQuery;
        pgReader?.close();
        rmSync(rootDir, { recursive: true, force: true });
      }
    };

    try {
      const small = await measureScopedWindow(600),
        large = await measureScopedWindow(2_400);
      for (const plan of [small.personPlan, large.personPlan]) {
        assert.ok(
          plan.scanNodes.some(
            (node) =>
              node.indexName === "ha_events_fleet_actor_person" ||
              node.indexName === "ha_events_visible_summary_revision",
          ),
          `expected indexed person scan, got ${JSON.stringify(plan.scanNodes)}`,
        );
        assert.ok(plan.rowsRead <= 500, `scoped person scan must stay <= 500 rows, got ${plan.rowsRead}`);
      }
      for (const plan of [small.nodePlan, large.nodePlan]) {
        assert.ok(
          plan.scanNodes.some(
            (node) =>
              node.indexName === "ha_events_fleet_node" || node.indexName === "ha_events_visible_summary_revision",
          ),
          `expected indexed node scan, got ${JSON.stringify(plan.scanNodes)}`,
        );
        assert.ok(plan.rowsRead <= 500, `scoped node scan must stay <= 500 rows, got ${plan.rowsRead}`);
      }
      assert.ok(
        large.personPlan.rowsRead <= small.personPlan.rowsRead + 10,
        `F16: scoped person scan grew across 4x non-matching history: ${small.personPlan.rowsRead} -> ${large.personPlan.rowsRead}`,
      );
      assert.ok(
        large.nodePlan.rowsRead <= small.nodePlan.rowsRead + 10,
        `F16: scoped node scan grew across 4x non-matching history: ${small.nodePlan.rowsRead} -> ${large.nodePlan.rowsRead}`,
      );
    } finally {
      await pgFixture.pool.end();
      await pgFixture.close();
    }
  },
);

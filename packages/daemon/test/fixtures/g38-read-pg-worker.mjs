// Test-only synchronous bridge, following pg-task-query-reader's MessagePort + Atomics
// pattern. PGlite and every query execute on the worker; no socket, Docker or host service.
import { parentPort, workerData } from "node:worker_threads";
import pg from "pg";
import assert from "node:assert/strict";
import path from "node:path";
import { localGitWorktreeSettlement } from "../../../storage/src/store/local-version-control-system.ts";
import { rebuildPgProjection } from "../../../storage/src/pg/pg-task-event-materialize.ts";
import { withPostgresTransaction } from "../../../storage/src/postgres/transaction.ts";
import { createPGliteStorageBackend } from "../../../storage/src/pglite/storage-backend.ts";
import { seedReadLedger, READ_HISTORY_BATCH_SIZE } from "./g38-read-ledger.mjs";
import { installReadProbe, resetReadProbe, snapshotReadProbe, planRowsRead } from "./g38-read-probe.mjs";

let sqlRowsRead = 0,
  sqlResultBytes = 0,
  measuring = false;
const original = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args) {
  const promise = original.apply(this, args);
  if (!measuring) return promise;
  if (!promise?.then) throw new Error("G38 PG probe expects promise-based queries");
  return promise.then(async (result) => {
    if (!measuring) return result;
    const query = typeof args[0] === "string" ? args[0] : args[0].text;
    let rows = 0;
    for (const item of Array.isArray(result) ? result : [result]) {
      rows += item.rows.length;
      sqlResultBytes += Buffer.byteLength(JSON.stringify(item.rows));
    }
    // Count database work, not just rows returned to JS: SELECT count(*) can scan
    // all history while returning one row. Bypass this wrapper for instrumentation.
    if (/^\s*(?:SELECT|WITH)\b/iu.test(query)) {
      const explained = await original.call(this, `EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF) ${query}`, args[1]);
      const plan = explained.rows[0]["QUERY PLAN"][0].Plan;
      rows = Math.max(rows, planRowsRead(plan));
    }
    sqlRowsRead += rows;
    return result;
  });
};
installReadProbe();
const { state, responsePort, size, dimension, rootDir, lowVisibility, allVisible } = workerData;
let backend;
const respond = (value) => {
  responsePort.postMessage(value);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
};
try {
  backend = await createPGliteStorageBackend({
    repoId: "g38-read",
    readAuthoredDocument: (logical) => {
      const node = localGitWorktreeSettlement.readNode(path.join(rootDir, "harness", ...logical.split("/")));
      return node ? { ...node, nodeKind: node.mode === "120000" ? "symbolic-link" : "file" } : null;
    },
    storage: {
      backend: "pglite",
      scope: {
        tenantId: "g38",
        projectId: "read",
        policyEpoch: 0,
        ...(lowVisibility || allVisible ? { readers: ["reader-visible"] } : {}),
      },
    },
  });
  const bundles = [],
    writerFence = { repoId: "g38-read", holderId: "read-fixture", epoch: 1 };
  let collecting = false;
  const directRelationFixture =
    (lowVisibility || allVisible) &&
    (dimension === "relation-visibility" || dimension === "relations") &&
    size >= 10_000;
  const seeded = directRelationFixture
    ? { baseRevision: 0, growth: 0 }
    : await seedReadLedger(
        {
          append: async (bundle) => {
            if (collecting) bundles.push(bundle);
            else await backend.eventStore.append(bundle, bundle.event.workspaceRevision - 1, writerFence);
          },
          beginHistory: () => {
            collecting = true;
          },
        },
        dimension,
        size,
      );
  // Both selected and historical command results stay bounded: a single all-history
  // command would make receipt hydration another growing input, beyond this axis.
  let accepted;
  if (directRelationFixture) {
    await backend.pool.query(
      `INSERT INTO ha_relations
         (tenant_id, project_id, policy_epoch, readers, relation_id, source_ref, target_ref,
          relation_type, relation_state, workspace_revision, value, freshness, current_target_version)
       SELECT 'g38', 'read', 0,
              CASE WHEN $2::boolean THEN ARRAY['reader-visible']::text[]
                   WHEN series > $1::bigint - GREATEST(1, CEIL($1::numeric / 100.0)::bigint)
                     THEN ARRAY['reader-visible']::text[]
                   ELSE ARRAY['reader-hidden']::text[] END,
              'relation-' || lpad(series::text, 8, '0'),
              'task/history-' || lpad(series::text, 8, '0'), 'task/other-' || lpad(series::text, 8, '0'),
              'depends-on', 'active', series,
              jsonb_build_object(
                'id', 'relation-' || lpad(series::text, 8, '0'),
                'revision', series,
                'source', 'task/history-' || lpad(series::text, 8, '0'),
                'target', 'task/other-' || lpad(series::text, 8, '0'),
                'type', 'depends-on',
                'strength', 'strong',
                'direction', 'directed',
                'origin', 'declared',
                'state', 'active',
                'rationale', 'Historical relation',
                'targetObservedVersion', NULL,
                'sourcePath', 'fixture:relation',
                'recordIndex', 0
              ),
              'current', NULL
       FROM generate_series(0, $1::bigint - 1) AS generated(series)`,
      [size, allVisible],
    );
  } else {
    for (let offset = 0; offset < bundles.length; offset += READ_HISTORY_BATCH_SIZE) {
      const batch = bundles.slice(offset, offset + READ_HISTORY_BATCH_SIZE),
        baseRevision = batch[0].event.workspaceRevision - 1,
        last = batch.pop();
      accepted = await backend.eventStore.append({ ...last, preceding: batch }, baseRevision, writerFence);
    }
    assert.equal(
      accepted.cut.revision,
      seeded.baseRevision + seeded.growth,
      "PG fixture did not seed the committed collection size",
    );
  }
  if (lowVisibility && !directRelationFixture) {
    // Keep the authorization port unchanged and make only the fixture's relation rows sparse:
    // the last 1% in the relation-id order are visible to the reader. This is an adversarial
    // page position, so an ordered scan must visit the hidden prefix before returning k=1.
    await backend.pool.query(`
      WITH ranked AS (
        SELECT relation_id,
               row_number() OVER (ORDER BY relation_id) AS row_number,
               count(*) OVER () AS total_rows
        FROM ha_relations
        WHERE tenant_id='g38' AND project_id='read' AND policy_epoch=0 AND relation_type='depends-on'
      ), visibility AS (
        SELECT relation_id,
               CASE WHEN row_number > total_rows - GREATEST(1, CEIL(total_rows / 100.0))
                 THEN ARRAY['reader-visible']::text[]
                 ELSE ARRAY['reader-hidden']::text[]
               END AS readers
        FROM ranked
      )
      UPDATE ha_relations AS relation
      SET readers = visibility.readers
      FROM visibility
      WHERE relation.tenant_id='g38' AND relation.project_id='read' AND relation.policy_epoch=0
        AND relation.relation_id=visibility.relation_id
    `);
  }
  // Bulk fixtures need current planner statistics, just like PostgreSQL bulk restores.
  // https://www.postgresql.org/docs/current/populate.html#POPULATE-ANALYZE
  // This is setup, outside both cold/warm cost measurements; no scan is hidden.
  await backend.pool.query("ANALYZE");
  respond({ ready: true });
} catch (error) {
  respond({ error: { message: error.message, stack: error.stack } });
}
parentPort.on("message", async ({ method, args = [] }) => {
  try {
    let result;
    if (method === "reset") {
      resetReadProbe();
      measuring = true;
      sqlRowsRead = 0;
      sqlResultBytes = 0;
    } else if (method === "snapshot") {
      measuring = false;
      result = { ...snapshotReadProbe(), sqlRowsRead, sqlResultBytes };
    } else if (method === "close") {
      await backend.close();
      parentPort.close();
    } else if (method === "rebuild") {
      await withPostgresTransaction(
        backend.pool,
        async (client) => {
          const keys = ["g38", "read", "g38-read"];
          const rows = (
            await client.query(
              "SELECT event_json,readers FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND repo_id=$3 ORDER BY revision",
              keys,
            )
          ).rows;
          const events = rows.map((row) => JSON.parse(row.event_json));
          const readers = new Map(rows.map((row, index) => [events[index].opId, row.readers]));
          await rebuildPgProjection(
            client,
            { tenantId: "g38", projectId: "read", policyEpoch: 0 },
            {
              events,
              sourceRevision: events.at(-1)?.workspaceRevision ?? 0,
              readEventReaders: (event) => readers.get(event.opId) ?? [],
              readContentBlob: async (sha256) =>
                (
                  await client.query(
                    "SELECT body FROM ha_content_blobs WHERE tenant_id=$1 AND project_id=$2 AND sha256=$3",
                    ["g38", "read", sha256],
                  )
                ).rows[0]?.body ?? null,
            },
          );
        },
        { tenantId: "g38", projectId: "read", policyEpoch: 0, readers: [] },
      );
    } else if (method === "canonical") result = await backend.eventStore.execute(args[0]);
    else result = await backend.projection[method](...args);
    respond({ result });
  } catch (error) {
    respond({ error: { message: error.message, stack: error.stack, code: error.code } });
  }
});

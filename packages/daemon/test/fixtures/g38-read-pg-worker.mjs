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
import { seedReadLedger } from "./g38-read-ledger.mjs";
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
const { state, responsePort, size, dimension, rootDir } = workerData;
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
      scope: { tenantId: "g38", projectId: "read", policyEpoch: 0 },
    },
  });
  const bundles = [],
    writerFence = { repoId: "g38-read", holderId: "read-fixture", epoch: 1 };
  let collecting = false;
  const seeded = await seedReadLedger(
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
  // Keep selected baseline operations independent. Only unrelated history shares a batch;
  // otherwise reading a baseline receipt would legitimately return a growing command k.
  const baseRevision = bundles[0].event.workspaceRevision - 1,
    last = bundles.pop();
  const accepted = await backend.eventStore.append({ ...last, preceding: bundles }, baseRevision, writerFence);
  assert.equal(
    accepted.cut.revision,
    seeded.baseRevision + seeded.growth,
    "PG fixture did not seed the committed collection size",
  );
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

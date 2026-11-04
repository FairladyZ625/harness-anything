// Test-only synchronous bridge, following pg-task-query-reader's MessagePort + Atomics
// pattern. PGlite and every query execute on the worker; no socket, Docker or host service.
import { parentPort, workerData } from "node:worker_threads";
import pg from "pg";
import path from "node:path";
import { localGitWorktreeSettlement } from "../../../storage/src/store/local-version-control-system.ts";
import { createPGliteStorageBackend } from "../../../storage/src/pglite/storage-backend.ts";
import { seedReadLedger } from "./g38-read-ledger.mjs";
import { installReadProbe, resetReadProbe, snapshotReadProbe, planRowsRead } from "./g38-read-probe.mjs";

let sqlRowsRead = 0,
  sqlResultBytes = 0,
  measuring = false;
const original = pg.Client.prototype.query;
pg.Client.prototype.query = function (...args) {
  const promise = original.apply(this, args);
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
let backend, cut;
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
  await seedReadLedger(
    {
      append: async (bundle) => {
        // Plans lose their frozen marker across structured-clone boundaries; seeding lives here.
        const accepted = await backend.eventStore.append(bundle, bundle.event.workspaceRevision - 1, {
          repoId: "g38-read",
          holderId: "read-fixture",
          epoch: 1,
        });
        cut = accepted.cut;
      },
      currentCut: () => cut,
    },
    dimension,
    size,
  );
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
    } else if (method === "canonical") result = await backend.eventStore.execute(args[0]);
    else result = await backend.projection[method](...args);
    respond({ result });
  } catch (error) {
    respond({ error: { message: error.message, stack: error.stack, code: error.code } });
  }
});

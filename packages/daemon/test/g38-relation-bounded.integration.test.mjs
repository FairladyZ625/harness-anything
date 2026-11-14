// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isMainThread,
  MessageChannel,
  parentPort,
  receiveMessageOnPort,
  Worker,
  workerData,
} from "node:worker_threads";
import pg from "pg";
import { canonicalEventCut, canonicalLedgerCut } from "@harness-anything/kernel";
import { createPGliteStorageBackend } from "../../storage/src/pglite/storage-backend.ts";
import { createPgStorageBackend } from "../../storage/src/pg/backend.ts";
import { localGitWorktreeSettlement } from "../../storage/src/store/local-version-control-system.ts";
import { pgRuntimeFixture } from "../../storage/test/postgres/pg-runtime.fixture.ts";
import { initRepo } from "../../storage/test/store/task-event-store.fixtures.ts";
import { READ_MARGINS, READ_SCALES, evaluateReadMeasurements } from "../../../tools/gates/cost-budget-reads.mjs";
import { READ_PROBES } from "./fixtures/g38-read-cost.mjs";
import { READ_HISTORY_BATCH_SIZE, seedReadLedger } from "./fixtures/g38-read-ledger.mjs";
import { installReadProbe, planRowsRead, resetReadProbe, snapshotReadProbe } from "./fixtures/g38-read-probe.mjs";
import { createReadFixtureRuntime } from "./fixtures/g38-read-runtime.mjs";

function collectScanNodes(plan, nodes = []) {
  if (/Scan$/u.test(plan["Node Type"] ?? "")) {
    nodes.push({
      nodeType: plan["Node Type"],
      relationName: plan["Relation Name"] ?? null,
      indexName: plan["Index Name"] ?? null,
      indexCond: plan["Index Cond"] ?? null,
      filter: plan["Filter"] ?? null,
      actualRows: plan["Actual Rows"] ?? 0,
      actualLoops: plan["Actual Loops"] ?? 1,
      rowsRemovedByFilter: plan["Rows Removed by Filter"] ?? 0,
      rowsRemovedByIndexRecheck: plan["Rows Removed by Index Recheck"] ?? 0,
    });
  }
  for (const child of plan.Plans ?? []) collectScanNodes(child, nodes);
  return nodes;
}

if (!isMainThread) {
  let sqlRowsRead = 0,
    sqlResultBytes = 0,
    measuring = false,
    statements = [];
  const original = pg.Client.prototype.query;
  pg.Client.prototype.query = function (...args) {
    const promise = original.apply(this, args);
    if (!measuring) return promise;
    return promise.then(async (result) => {
      if (!measuring) return result;
      const query = typeof args[0] === "string" ? args[0] : args[0].text;
      let rows = 0,
        bytes = 0;
      for (const item of Array.isArray(result) ? result : [result]) {
        rows += item.rows.length;
        bytes += Buffer.byteLength(JSON.stringify(item.rows));
      }
      sqlResultBytes += bytes;
      let plan = null,
        scanNodes = [];
      if (/^\s*(?:SELECT|WITH)\b/iu.test(query)) {
        const explained = await original.call(
          this,
          `EXPLAIN (ANALYZE, FORMAT JSON, BUFFERS, TIMING OFF) ${query}`,
          args[1],
        );
        plan = explained.rows[0]["QUERY PLAN"][0].Plan;
        scanNodes = collectScanNodes(plan);
        rows = Math.max(rows, planRowsRead(plan));
      }
      sqlRowsRead += rows;
      statements.push({
        sql: query.replace(/\s+/gu, " ").trim(),
        returnedRows: Array.isArray(result)
          ? result.reduce((sum, item) => sum + item.rows.length, 0)
          : result.rows.length,
        rowsRead: rows,
        resultBytes: bytes,
        planNodeType: plan?.["Node Type"] ?? null,
        scanNodes,
        plan,
      });
      return result;
    });
  };

  installReadProbe();
  const { state, responsePort, dimension, size, rootDir } = workerData;
  const respond = (value) => {
    responsePort.postMessage(value);
    Atomics.store(state, 0, 1);
    Atomics.notify(state, 0);
  };
  let backend, nativeFixture;
  try {
    const lowVisibility = dimension === "relation-visibility";
    const scope = {
      tenantId: "g38",
      projectId: "read",
      policyEpoch: 0,
      readers: lowVisibility ? ["reader-visible"] : [],
    };
    const backendOptions = {
      repoId: "g38-read",
      readAuthoredDocument: (logical) => {
        const node = localGitWorktreeSettlement.readNode(path.join(rootDir, "harness", ...logical.split("/")));
        return node ? { ...node, nodeKind: node.mode === "120000" ? "symbolic-link" : "file" } : null;
      },
    };
    if (workerData.backend === "postgres") {
      nativeFixture = await pgRuntimeFixture();
      backend = {
        ...createPgStorageBackend({
          ...backendOptions,
          pool: nativeFixture.pool,
          scope,
        }),
        pool: nativeFixture.pool,
        close: async () => {
          await nativeFixture.pool.end();
          await nativeFixture.close();
        },
      };
    } else {
      backend = await createPGliteStorageBackend({
        ...backendOptions,
        storage: { backend: "pglite", scope },
      });
    }
    const bundles = [],
      writerFence = { repoId: "g38-read", holderId: "read-fixture", epoch: 1 };
    let collecting = false;
    await seedReadLedger(
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
    for (let offset = 0; offset < bundles.length; offset += READ_HISTORY_BATCH_SIZE) {
      const batch = bundles.slice(offset, offset + READ_HISTORY_BATCH_SIZE),
        baseRevision = batch[0].event.workspaceRevision - 1,
        last = batch.pop();
      await backend.eventStore.append({ ...last, preceding: batch }, baseRevision, writerFence);
    }
    if (lowVisibility)
      await (nativeFixture?.adminPool ?? backend.pool).query(`
      WITH ranked AS (SELECT relation_id,row_number() OVER(ORDER BY relation_id) AS n,
        count(*) OVER() AS total FROM ha_relations WHERE tenant_id='g38' AND project_id='read'
        AND policy_epoch=0 AND relation_type='depends-on')
      UPDATE ha_relations r SET readers=CASE WHEN n>total-GREATEST(1,CEIL(total/100.0))
        THEN ARRAY['reader-visible'] ELSE ARRAY['reader-hidden'] END FROM ranked
      WHERE r.tenant_id='g38' AND r.project_id='read' AND r.policy_epoch=0 AND r.relation_id=ranked.relation_id`);
    await (nativeFixture?.adminPool ?? backend.pool).query("ANALYZE");
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
        statements = [];
      } else if (method === "snapshot") {
        measuring = false;
        result = {
          counts: { ...snapshotReadProbe(), sqlRowsRead, sqlResultBytes },
          statements,
        };
      } else if (method === "close") {
        await backend.close();
        parentPort.close();
      } else if (method === "canonical") {
        result = await backend.eventStore.execute(args[0]);
      } else {
        result = await backend.projection[method](...args);
      }
      respond({ result });
    } catch (error) {
      respond({ error: { message: error.message, stack: error.stack, code: error.code } });
    }
  });
} else {
  async function tracePgProbe(dimension, size, probeIds, backend = "pglite") {
    installReadProbe();
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-g38-p4-trace-"));
    initRepo(rootDir);
    writeFileSync(
      path.join(rootDir, "harness/harness.yaml"),
      "schema: harness-anything/v1\nname: parity\nsettings: {}\n",
    );
    const state = new Int32Array(new SharedArrayBuffer(4)),
      { port1, port2 } = new MessageChannel(),
      worker = new Worker(new URL(import.meta.url), {
        workerData: { state, responsePort: port2, dimension, size, rootDir, backend },
        transferList: [port2],
        execArgv: [],
      });
    worker.on("error", () => {});
    const wait = () => {
      if (Atomics.wait(state, 0, 0, 240_000) === "timed-out") throw new Error("trace worker timed out");
      const response = receiveMessageOnPort(port1)?.message;
      if (!response) throw new Error("trace worker returned no response");
      if (response.error) throw Object.assign(new Error(response.error.message), response.error);
      return response;
    };
    const request = (method, ...args) => {
      Atomics.store(state, 0, 0);
      worker.postMessage({ method, args });
      return wait().result;
    };
    try {
      wait();
      const projection = new Proxy(
          {},
          { get: (_, key) => (key === "path" ? "pglite:read-fixture" : (...args) => request(key, ...args)) },
        ),
        canonical = (operation, extra = {}) => request("canonical", { operation, ...extra }),
        store = {
          readHead: () => canonical("head"),
          currentCut: () => canonicalLedgerCut("g38-read", canonical("head")),
          currentCommit: () => null,
          ledgerMetadata: () => ({ repoId: "g38-read", generation: 3, revision: canonical("head")?.revision ?? 0 }),
          publication: (event) => ({ commitSha: null, cut: canonicalEventCut("g38-read", event) }),
          canonicalRef: "pglite:canonical",
          read: () => canonical("stream"),
          readEvents: (afterRevision, limit, query) => canonical("events", { afterRevision, limit, query }),
          readEvent: (value) => canonical("event", { key: "op_id", value }),
          readEventById: (value) => canonical("event", { key: "event_id", value }),
          queryEvents: (query) => canonical("events", { query }),
          readEventAtRevision: (value) => canonical("event", { key: "revision", value }),
          readBatch: (cursor, maxItems) => canonical("batch", { cursor, maxItems }),
          readContentBlob: (sha256) => canonical("content", { sha256 }),
          readContentBlobRange: (sha256, offset, maxBytes) => canonical("content-range", { sha256, offset, maxBytes }),
          readContentBlobSize: (sha256) => canonical("content-size", { sha256 }),
          drain: async () => {},
        };
      const runtime = await createReadFixtureRuntime({ projection, store, rootDir }, () => "2026-11-05T00:00:00Z");
      const measurements = {};
      for (const probeId of probeIds) {
        const probe = READ_PROBES[probeId];
        const context = { rootDir, projection, store, runtime };

        request("reset");
        resetReadProbe();
        const first = await probe.run(context);
        const firstRemote = request("snapshot"),
          firstLocal = snapshotReadProbe();
        const firstCall = Object.fromEntries(
          Object.keys(firstLocal).map((key) => [key, firstLocal[key] + firstRemote.counts[key]]),
        );

        request("reset");
        resetReadProbe();
        const warm = await probe.run(context);
        const warmRemote = request("snapshot"),
          warmLocal = snapshotReadProbe();
        const counts = Object.fromEntries(
          Object.keys(warmLocal).map((key) => [key, warmLocal[key] + warmRemote.counts[key]]),
        );

        measurements[probeId] = {
          dimension,
          size,
          probeId,
          firstResultSize: probe.size(first),
          resultSize: probe.size(warm),
          firstCall,
          counts,
          firstStatements: firstRemote.statements,
          warmStatements: warmRemote.statements,
        };
      }
      return measurements;
    } finally {
      try {
        request("close");
      } catch {
        // Worker already exited.
      }
      await worker.terminate();
      port1.close();
      rmSync(rootDir, { recursive: true, force: true });
    }
  }

  // Removal authority: dec_193D3BD6C59FCA1ECE4C820415 and dec_9806C22E9717DD821A205AABAA.
  // These are the original 200/2000 probes, without P4 exemptions or threshold changes.
  const cases = {
    "runtime-sessions": ["cli-decision-validate", "cli-decision-verify", "cli-graph"],
    dispatches: ["cli-decision-validate", "cli-decision-verify", "cli-graph"],
    relations: ["agenda", "cli-decision-validate", "cli-decision-verify", "cli-graph", "task-list"],
    "relation-visibility": ["relation-page-low-visibility"],
  };
  for (const backend of (process.env.FLEET_STRESS_G38_P4_BACKENDS ?? "pglite,postgres").split(","))
    for (const [dimension, probeIds] of Object.entries(cases)) {
      test(
        `P4 ${backend}/${dimension} original-scale reads stay bounded`,
        {
          skip:
            backend === "pglite" && Number(process.versions.node.split(".")[0]) < 26
              ? "PGlite database measurements require Node 26; cost-budget-reads runs on Node 26"
              : false,
        },
        async (t) => {
          const pair = {};
          for (const [scale, size] of Object.entries(READ_SCALES)) {
            pair[scale] = await tracePgProbe(dimension, size, probeIds, backend);
            t.diagnostic(JSON.stringify({ p4Trace: { backend, dimension, scale, measurements: pair[scale] } }));
          }
          for (const id of probeIds) {
            assert.equal(pair.small[id].resultSize, pair.large[id].resultSize, `${id} fixed output`);
            assert.equal(pair.small[id].firstResultSize, pair.large[id].firstResultSize);
            assert.equal(pair.small[id].firstResultSize, pair.small[id].resultSize);
            assert.equal(pair.large[id].firstResultSize, pair.large[id].resultSize);
            for (const phase of ["firstCall", "counts"])
              for (const [metric, margin] of Object.entries(READ_MARGINS))
                assert.ok(
                  pair.large[id][phase][metric] <= pair.small[id][phase][metric] + margin,
                  `${id}/${phase}/${metric}: ${pair.small[id][phase][metric]} -> ${pair.large[id][phase][metric]}`,
                );
          }
          if (backend === "pglite") {
            const probes = Object.fromEntries(probeIds.map((id) => [id, READ_PROBES[id]])),
              reads = [...new Set(probeIds.flatMap((id) => READ_PROBES[id].reads))],
              result = evaluateReadMeasurements({
                section: {
                  knownScaling: [],
                  readCoverage: {
                    measured: Object.fromEntries(
                      reads.map((read) => [
                        read,
                        { measurements: probeIds.filter((id) => READ_PROBES[id].reads.includes(read)) },
                      ]),
                    ),
                    notApplicable: [],
                  },
                },
                inventory: reads.map((id) => ({ id })),
                probes,
                backends: [backend],
                dimensions: [dimension],
                measured: {
                  [backend]: {
                    [dimension]: Object.fromEntries(
                      probeIds.map((id) => [id, { small: pair.small[id], large: pair.large[id] }]),
                    ),
                  },
                },
              });
            assert.deepEqual(result.errors, [], "production G38 evaluator without any P4 exemption");
          }
        },
      );
    }
}

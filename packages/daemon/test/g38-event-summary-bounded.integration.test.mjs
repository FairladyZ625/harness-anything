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
import {
  canonicalEventCut,
  canonicalEventEntityRefs,
  canonicalLedgerCut,
  compileTaskProgress,
  sha256Text,
  taskLifecycleWritePlan,
} from "@harness-anything/kernel";
import { serializeCanonicalEventUnchecked } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { canonicalEventSummary } from "@harness-anything/kernel/internal/domain/canonical-event-summary.ts";
import { compileEntityDocumentRematerialization } from "@harness-anything/kernel/internal/domain/entity-document-event.ts";
import { compileFactWrite } from "@harness-anything/kernel/internal/domain/fact-event.ts";
import { normalizeHistoricalEvent } from "@harness-anything/kernel/internal/domain/historical-event-normalization.ts";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { createPGliteStorageBackend } from "../../storage/src/pglite/storage-backend.ts";
import { createPgStorageBackend } from "../../storage/src/pg/backend.ts";
import {
  backfillPgDefaultEventSummaries,
  backfillPgDefaultEventSummariesPage,
} from "../../storage/src/pg/pg-event-read-index-migration.ts";
import { createPgTaskQueryReader } from "../../storage/src/pg/pg-task-query-reader.ts";
import { rebuildPgProjection } from "../../storage/src/pg/pg-task-event-materialize.ts";
import { withPostgresTransaction } from "../../storage/src/postgres/transaction.ts";
import { makeTaskProjection } from "../../storage/src/projection/rebuildable-task-projection.ts";
import { localGitWorktreeSettlement } from "../../storage/src/store/local-version-control-system.ts";
import { canonicalEventWritePlan } from "../../storage/src/store/task-event-store.ts";
import { pgRuntimeFixture } from "../../storage/test/postgres/pg-runtime.fixture.ts";
import { retiredCiQueryFixtures } from "../../storage/test/postgres/pg-task-event-parity.fixture.ts";
import { fact } from "../../storage/test/store/relation-graph-projection.fixtures.ts";
import { docBundle, eventAt, initRepo } from "../../storage/test/store/task-event-store.fixtures.ts";
import { memoryEventStore } from "../../storage/test/store/task-owned-entity-projection.fixtures.ts";
import {
  READ_MARGINS,
  READ_OUTPUT_SCALES,
  READ_SCALES,
  evaluateReadMeasurements,
} from "../../../tools/gates/cost-budget-reads.mjs";
import { readObserveEventTail } from "../src/observe-tail.ts";
import { READ_PROBES, measureReadScale } from "./fixtures/g38-read-cost.mjs";
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
        const explained = await original.call(this, `EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF) ${query}`, args[1]);
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
          scope: { tenantId: "g38", projectId: "read", policyEpoch: 0, readers: [] },
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
        storage: { backend: "pglite", scope: { tenantId: "g38", projectId: "read", policyEpoch: 0 } },
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
    if (nativeFixture) {
      // Populate exactly the input written by the previous-binary INSERT trigger. The native
      // upgrade consumer separately proves an actual old-column INSERT reaches this function.
      await nativeFixture.adminPool.query(
        "UPDATE ha_events SET default_summary_json=ha_default_summary_source(event_json) WHERE event_id='history-large-event'",
      );
    }
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
  async function tracePgProbe(dimension, size, probeId, backend = "pglite") {
    installReadProbe();
    const rootDir = mkdtempSync(path.join(tmpdir(), "ha-g38-p2-trace-"));
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

      return {
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

  test("default event views preserve raw UTC timestamp precision through every materialization path", async (t) => {
    const fixture = await pgRuntimeFixture(),
      repoId = "raw-summary-time",
      scope = { tenantId: "raw-time", projectId: "raw-time", policyEpoch: 1, readers: [] },
      backend = createPgStorageBackend({ pool: fixture.pool, repoId, scope }),
      times = ["2026-08-13T00:00:00.123456Z", "2026-08-13T00:00:00Z"],
      events = [1, 2, 3, 4].map((revision) => ({ ...eventAt(revision), occurredAt: times[(revision - 1) % 2] })),
      keys = [scope.tenantId, scope.projectId, scope.policyEpoch, repoId];
    let reader;
    try {
      for (const event of events.slice(0, 2))
        await backend.eventStore.append(
          { event, plan: taskLifecycleWritePlan(event), blobs: [] },
          event.workspaceRevision - 1,
          { repoId, holderId: "raw-time-writer", epoch: 1 },
        );
      reader = createPgTaskQueryReader({ connectionString: fixture.connectionString, scope, repoId });
      const verify = async (stage, selected) => {
        const expected = selected.map(canonicalEventSummary),
          views = reader.withSession((projection) => {
            const input = { repoId, rootDir: tmpdir(), mode: "local", projection };
            return {
              default: projection.readEventSummaries(0, 20).events,
              workspace: projection.readEventSummaries(0, 20, { taskIds: selected.map((event) => event.taskId) })
                .events,
              history: readObserveEventTail({ ...input, payload: { kind: "events", direction: "history" } }).items,
              follow: readObserveEventTail({
                ...input,
                payload: { kind: "events", direction: "follow", cursor: { kind: "events", revision: 0 } },
              }).items,
            };
          });
        t.diagnostic(
          JSON.stringify({
            timestampStage: stage,
            expected: expected.map((event) => event.occurredAt),
            actual: views.default.map((event) => event.occurredAt),
          }),
        );
        for (const [view, actual] of Object.entries(views))
          await t.test(`${stage}/${view}`, () => assert.deepEqual(actual, expected));
      };
      await verify("current writer", events.slice(0, 2));
      await backfillPgDefaultEventSummaries(fixture.adminPool, scope, repoId);
      for (const event of events.slice(2)) {
        const body = serializeCanonicalEventUnchecked(event).trimEnd();
        await fixture.adminPool.query(
          `INSERT INTO ha_events(tenant_id,project_id,repo_id,revision,op_id,event_id,event_type,event_json,event_digest,
             occurred_at,policy_epoch,readers,entity_refs,actor_refs)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            scope.tenantId,
            scope.projectId,
            repoId,
            event.workspaceRevision,
            event.opId,
            event.eventId,
            event.type,
            body,
            `sha256:${sha256Text(body)}`,
            event.occurredAt,
            scope.policyEpoch,
            scope.readers,
            canonicalEventEntityRefs(event),
            [event.actor.principal.personId, event.actor.executor.id],
          ],
        );
      }
      await fixture.adminPool.query(
        "UPDATE ha_repo_heads SET revision=4,head_op_id=$5 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4",
        [...keys, events.at(-1).opId],
      );
      await fixture.adminPool.query(
        "UPDATE ha_projection_meta SET watermark=4,source_revision=4 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND projection_name='task/v1'",
        keys.slice(0, 3),
      );
      await verify("previous writer after ready", events);
      const canonicalBodies = await fixture.adminPool.query("SELECT event_json FROM ha_events ORDER BY revision");
      await fixture.adminPool.query(
        "UPDATE ha_events SET default_summary_json=NULL WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4",
        keys,
      );
      await fixture.adminPool.query(
        "DELETE FROM ha_event_summary_state WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4",
        keys,
      );
      await backfillPgDefaultEventSummaries(fixture.adminPool, scope, repoId);
      await verify("management backfill", events);
      reader.rebuild();
      await verify("cold rebuild", events);
      assert.deepEqual(
        (await fixture.adminPool.query("SELECT event_json FROM ha_events ORDER BY revision")).rows,
        canonicalBodies.rows,
        "summary materialization must preserve canonical bytes",
      );
    } finally {
      reader?.close();
      await fixture.pool.end();
      await fixture.close();
    }
  });

  test("R8 and R9 PostgreSQL event summary queries preserve SQLite parity across edge shapes, tail cursors, and backfill", async () => {
    const pgFixture = await pgRuntimeFixture(),
      rootDir = mkdtempSync(path.join(tmpdir(), "ha-g38-p2-parity-")),
      scope = { tenantId: "p2-tenant", projectId: "p2-project", policyEpoch: 1, readers: ["visible"] },
      repoId = "p2-parity",
      fence = { repoId, holderId: "p2-writer", epoch: 1 };
    let pgBackend, pgReader, sqlite;
    try {
      initRepo(rootDir);
      pgBackend = createPgStorageBackend({ pool: pgFixture.pool, scope, repoId });
      let next = 1,
        plannedCut = canonicalLedgerCut(repoId, null);
      const currentCut = () => plannedCut,
        appended = [],
        blobs = new Map();
      const appendBundle = async (bundle) => {
        await pgBackend.eventStore.append(bundle, bundle.event.workspaceRevision - 1, fence);
        appended.push(bundle.event);
        for (const blob of bundle.blobs ?? []) blobs.set(blob.sha256, Buffer.from(blob.body));
        const { opId: _opId, ...identity } = canonicalEventCut(repoId, bundle.event);
        plannedCut = identity;
        next = bundle.event.workspaceRevision + 1;
      };

      const alphaLifecycle = lifecycleFixture({
        taskId: "task_alpha",
        executionId: "execution_alpha",
        reviewId: "review_alpha",
      }).events;
      for (const lifecycleEvent of alphaLifecycle.slice(0, 5)) {
        const current = {
          ...lifecycleEvent,
          workspaceRevision: next,
          opId: `op-alpha-${next}`,
          eventId: `ev-alpha-${next}`,
        };
        await appendBundle({
          event: current,
          plan: taskLifecycleWritePlan(current),
          blobs: [],
        });
      }
      const betaCreated = {
        ...eventAt(next),
        taskId: "task_beta",
        payload: { ...eventAt(next).payload, task: { ...eventAt(next).payload.task, taskId: "task_beta" } },
      };
      await appendBundle({ event: betaCreated, plan: taskLifecycleWritePlan(betaCreated), blobs: [] });

      const alphaActor = alphaLifecycle[0].actor,
        alphaPackagePath = "tasks/task_alpha-fixture";
      let alphaProgressDoc = null;
      const appendAlphaProgress = async (label, text, occurredAt) => {
        const compiled = compileTaskProgress({
          taskId: "task_alpha",
          executionId: "execution_alpha",
          packagePath: alphaPackagePath,
          text,
          evidence: [],
          currentDocument: alphaProgressDoc,
          activeLease: null,
          startRecoveryAvailable: false,
          asOwner: true,
          taskCreatedBy: alphaActor,
          actor: alphaActor,
          source: "local",
          eventId: `ev-${label}-${next}`,
          opId: `op-${label}-${next}`,
          workspaceRevision: next,
          occurredAt,
        });
        await appendBundle(compiled);
        alphaProgressDoc = {
          path: compiled.path,
          blobSha256: compiled.blobs[0].sha256,
          body: compiled.body,
        };
        return compiled;
      };
      for (const [label, length] of [
        ["len279", 279],
        ["len280", 280],
        ["len281", 281],
      ]) {
        const boundaryProgress = await appendAlphaProgress(
          label,
          `${label}-${"x".repeat(length - label.length - 1)}`,
          "2026-11-10T00:01:00.000Z",
        );
        assert.equal(boundaryProgress.event.payload.text.length, length);
      }

      // Astral emoji splitting UTF-16 code unit 280 + NUL bytes + large >16 KiB body:
      // default summary uses JS slice(0, 280), which differs from SQL left(..., 280) on surrogate pairs.
      const multibyteText = `${"汉".repeat(279)}😀-nul-\u0000\u0000-${"z".repeat(18_000)}`;
      await appendAlphaProgress("multibyte", multibyteText, "2026-11-10T00:02:00.000Z");

      // Fact with top-level factId + 281-char statement + actor executor id.
      const draftFact = fact(next);
      await appendBundle(
        compileFactWrite({
          event: {
            ...draftFact,
            factId: "F-99999999",
            actor: betaCreated.actor,
            payload: {
              ...draftFact.payload,
              statement: `fact-${"s".repeat(276)}`,
              evidenceSource: "g38-p2-parity",
            },
          },
        }),
      );

      // Document writes + entity-document rematerialization carrying non-empty payload.documentClaims.
      await appendBundle(
        docBundle({ currentCut }, "alpha doc 1\n", next, `op-doc-${next}`, "tasks/task_alpha-pkg/artifacts/out-1.md"),
      );
      await appendBundle(
        docBundle({ currentCut }, "beta doc 1\n", next, `op-doc-${next}`, "tasks/task_beta-pkg/artifacts/out-1.md"),
      );
      await appendBundle(
        compileEntityDocumentRematerialization({
          actor: alphaActor,
          source: "local",
          occurredAt: "2026-11-10T00:02:30.000Z",
          opId: `op-remat-${next}`,
          workspaceRevision: next,
          rationale: "verify documentClaims summary projection",
          entityRefs: ["decision/dec_FIXTURE"],
          updates: [
            {
              path: "decisions/decision-dec_FIXTURE/decision.md",
              policyId: "markdown-body-replaceable/v1",
              mediaType: "text/markdown",
              body: `# Decision\n\n${"prose ".repeat(500)}\n`,
            },
          ],
        }),
      );

      // Runtime session bound via payload.taskBinding.taskId only (task_index_id = task_alpha, canonical_task_id = NULL).
      const sessionStarted = {
        schema: "agent-runtime-event/v1",
        eventId: `ev-session-${next}`,
        opId: `op-session-${next}`,
        workspaceRevision: next,
        type: "runtime_session_started",
        occurredAt: "2026-11-10T00:03:00.000Z",
        actor: betaCreated.actor,
        source: "local",
        payload: {
          runtimeSessionId: "session_p2_alpha",
          instanceId: "runtime-query-instance",
          installationId: "runtime-query-installation",
          kindId: "codex",
          definitionSnapshotRef: "artifact:runtime-definitions/codex/v1",
          taskBinding: { taskId: "task_alpha", executionId: "execution_alpha" },
          launchGeneration: 1,
          attachable: true,
        },
      };
      await appendBundle({
        event: sessionStarted,
        plan: canonicalEventWritePlan(sessionStarted, "agent-runtime/v1", sessionStarted.opId),
        blobs: [],
      });

      // Pad past 64 events to exercise multi-page 64-row backfill batching.
      while (appended.length < 68) {
        const filler = eventAt(next);
        await appendBundle({ event: filler, plan: taskLifecycleWritePlan(filler), blobs: [] });
      }

      // Inject retired CI observation (carrying top-level taskId = "task_alpha") + NUL/lone-surrogate historical row
      // directly into ha_events & SQLite memory stream to verify retired-CI exclusion and non-JSONB surrogate fidelity.
      const retiredCi = {
          ...retiredCiQueryFixtures()[0],
          taskId: "task_alpha",
          workspaceRevision: next,
          opId: `op-retired-ci-${next}`,
          eventId: `ev-retired-ci-${next}`,
        },
        surrogateFactSeed = compileFactWrite({
          event: {
            ...fact(next + 1),
            eventId: `ev-surrogate-${next + 1}`,
            opId: `op-surrogate-${next + 1}`,
            taskId: "task_alpha",
            factId: "F-12345678",
            actor: betaCreated.actor,
            occurredAt: "2026-11-10T00:05:00.000Z",
            payload: {
              ...fact(next + 1).payload,
              statement: "surrogate-seed",
              observedAt: "2026-11-10T00:05:00.000Z",
            },
          },
        }),
        loneSurrogateEvent = {
          ...surrogateFactSeed.event,
          payload: {
            ...surrogateFactSeed.event.payload,
            statement: `surrogate-\u0000-\ud800-${"q".repeat(280)}`,
          },
          occurredAt: "2026-11-10T00:05:00.000Z",
        };
      for (const blob of surrogateFactSeed.blobs) blobs.set(blob.sha256, Buffer.from(blob.body));
      const allEvents = [...appended, retiredCi, loneSurrogateEvent];
      await withPostgresTransaction(
        pgFixture.pool,
        async (client) => {
          for (const blob of surrogateFactSeed.blobs) {
            const bytes = Buffer.from(blob.body);
            await client.query(
              `INSERT INTO ha_content_blobs (tenant_id,project_id,sha256,size,body,readers,policy_epoch)
               VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id,project_id,sha256) DO NOTHING`,
              [scope.tenantId, scope.projectId, blob.sha256, bytes.byteLength, bytes, scope.readers, scope.policyEpoch],
            );
          }
          for (const raw of [retiredCi, surrogateFactSeed.event]) {
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
                scope.readers,
                canonicalEventEntityRefs(raw),
                [raw.actor.principal.personId, ...(raw.actor.executor ? [raw.actor.executor.id] : [])],
              ],
            );
          }
          const headRev = loneSurrogateEvent.workspaceRevision;
          await client.query(
            "UPDATE ha_repo_heads SET revision=$5, head_op_id=$6 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4",
            [scope.tenantId, scope.projectId, scope.policyEpoch, repoId, headRev, loneSurrogateEvent.opId],
          );
          let canonicalRowsRead = 0;
          const summaryBatchSizes = [];
          const replayClient = Object.create(client);
          replayClient.query = async (...args) => {
            if (/UPDATE ha_events AS e\s+SET default_summary_json/u.test(args[0]))
              summaryBatchSizes.push(Math.max(...args[1].filter(Array.isArray).map((values) => values.length)));
            const result = await client.query(...args);
            for (const part of Array.isArray(result) ? result : [result])
              canonicalRowsRead += part.rows.filter((row) => Object.hasOwn(row, "event_json")).length;
            return result;
          };
          await rebuildPgProjection(replayClient, scope, {
            events: [...appended, retiredCi, surrogateFactSeed.event],
            sourceRevision: headRev,
            readContentBlob: (sha) => blobs.get(sha) ?? null,
          });
          assert.equal(
            canonicalRowsRead,
            0,
            "rebuild must reuse its canonical input instead of reading event bodies again",
          );
          assert.ok(summaryBatchSizes.length > 0);
          assert.ok(
            summaryBatchSizes.every((size) => size <= 64),
            "summary SQL batches must stay at most 64 rows",
          );
          await client.query(
            "UPDATE ha_events SET event_json = $5 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 AND revision=$6",
            [
              scope.tenantId,
              scope.projectId,
              scope.policyEpoch,
              repoId,
              serializeCanonicalEventUnchecked(loneSurrogateEvent).trimEnd(),
              loneSurrogateEvent.workspaceRevision,
            ],
          );
          // A previous writer that updates an existing event body keeps the derived default
          // summary converged in the same trigger transaction; bounded backfill has nothing left
          // to process for this row.
          const seedBackfill = await backfillPgDefaultEventSummariesPage(client, scope, repoId);
          assert.deepEqual(seedBackfill, { processed: 0, done: true });
        },
        scope,
      );

      sqlite = makeTaskProjection({
        rootDir,
        eventStore: {
          ...memoryEventStore(allEvents, blobs),
          readHead: () => ({
            revision: loneSurrogateEvent.workspaceRevision,
            eventDigest: `sha256:${sha256Text(serializeCanonicalEventUnchecked(loneSurrogateEvent))}`,
          }),
        },
      });
      sqlite.catchUp();

      pgReader = createPgTaskQueryReader({ connectionString: pgFixture.connectionString, scope, repoId });
      const assertParity = () => {
        pgReader.withSession((pgQueries) => {
          assert.deepEqual(pgQueries.readEventSummaries(0, 200), sqlite.readEventSummaries(0, 200));
          assert.deepEqual(pgQueries.readEventSummaries(5, 10), sqlite.readEventSummaries(5, 10));

          // R9 cases: task_index_id vs canonical_task_id divergence, empty scope, retired CI exclusion,
          // reverse page at same cut, multi-member merge + deduplication, and exact hasMore boundary.
          assert.deepEqual(
            pgQueries.readEventSummaries(0, 50, { taskIds: [] }),
            sqlite.readEventSummaries(0, 50, { taskIds: [] }),
          );
          const alphaAll = pgQueries.readEventSummaries(0, 50, { taskIds: ["task_alpha"] });
          assert.deepEqual(alphaAll, sqlite.readEventSummaries(0, 50, { taskIds: ["task_alpha"] }));
          assert.equal(
            alphaAll.events.some((item) => item.schema === "task-progress-event/v1"),
            false,
            "task-progress-event/v1 has task_index_id=task_alpha but canonical_task_id=NULL and must stay excluded",
          );
          assert.equal(
            alphaAll.events.some((item) => item.type === "runtime_session_started"),
            false,
            "runtime_session_started taskBinding has task_index_id=task_alpha but canonical_task_id=NULL",
          );
          assert.equal(
            alphaAll.events.some((item) => item.type === "ci_run_observed"),
            false,
            "retired ci_run_observed must stay excluded before page limit",
          );
          const count = alphaAll.events.length;
          assert.ok(count >= 4);
          assert.equal(pgQueries.readEventSummaries(0, count, { taskIds: ["task_alpha"] }).hasMore, false);
          const clippedPage = pgQueries.readEventSummaries(0, count - 1, { taskIds: ["task_alpha"] });
          assert.equal(clippedPage.hasMore, true);
          assert.deepEqual(clippedPage, sqlite.readEventSummaries(0, count - 1, { taskIds: ["task_alpha"] }));
          assert.deepEqual(
            pgQueries.readEventSummaries(3, 4, { taskIds: ["task_beta", "task_alpha", "task_alpha"] }),
            sqlite.readEventSummaries(3, 4, { taskIds: ["task_beta", "task_alpha", "task_alpha"] }),
          );

          // R8 cases: default vs fleet shape & 280-code-unit / surrogate / documentClaims / observe.tail cursors.
          const defaultSummaries = pgQueries.readEventSummaries(0, 200).events;
          const fleetSummaries = pgQueries.readEventSummaries(0, 200, "fleet").events;
          const defaultDoc = defaultSummaries.find((item) => item.schema === "entity-document-event/v1");
          const fleetDoc = fleetSummaries.find((item) => item.eventId === defaultDoc.eventId);
          assert.deepEqual(defaultDoc.payload.documentClaims, [{ path: "decisions/decision-dec_FIXTURE/decision.md" }]);
          assert.equal("documentClaims" in fleetDoc.payload, false);

          const defaultReview = defaultSummaries.find((item) => item.type === "review_recorded");
          const fleetReview = fleetSummaries.find((item) => item.eventId === defaultReview.eventId);
          assert.deepEqual(defaultReview.payload.review, { verdict: "approved" });
          assert.equal("review" in fleetReview.payload, false);

          const default281 = defaultSummaries.find((item) => String(item.payload.text ?? "").startsWith("len281-"));
          const fleet281 = fleetSummaries.find((item) => item.eventId === default281.eventId);
          assert.equal(default281.payload.text.length, 280);
          assert.equal(default281.payload.text.endsWith("…"), false);
          assert.equal(fleet281.payload.text.length, 280);
          assert.equal(fleet281.payload.text.endsWith("…"), true);

          const defaultMultibyte = defaultSummaries.find((item) => item.eventId.startsWith("ev-multibyte-"));
          assert.equal(defaultMultibyte.payload.text.length, 280);
          assert.equal(defaultMultibyte.payload.text, `${"汉".repeat(279)}\ud83d`);

          const defaultSurrogate = defaultSummaries.find((item) => item.eventId === loneSurrogateEvent.eventId);
          assert.equal(defaultSurrogate.payload.statement.length, 280);
          assert.equal(defaultSurrogate.payload.statement.startsWith("surrogate-\u0000-\ud800-"), true);
          assert.equal(defaultSurrogate.occurredAt, "2026-11-10T00:05:00.000Z");

          // observe.tail history + pagination + follow + invalid_cursor parity.
          const tailPg1 = readObserveEventTail({
              repoId,
              rootDir,
              mode: "local",
              projection: pgQueries,
              payload: { kind: "events", direction: "history" },
            }),
            tailSq1 = readObserveEventTail({
              repoId,
              rootDir,
              mode: "local",
              projection: sqlite,
              payload: { kind: "events", direction: "history" },
            });
          assert.deepEqual(tailPg1, tailSq1);
          assert.equal(tailPg1.done, false);

          const tailPg2 = readObserveEventTail({
              repoId,
              rootDir,
              mode: "local",
              projection: pgQueries,
              payload: { kind: "events", direction: "history", cursor: tailPg1.historyCursor },
            }),
            tailSq2 = readObserveEventTail({
              repoId,
              rootDir,
              mode: "local",
              projection: sqlite,
              payload: { kind: "events", direction: "history", cursor: tailSq1.historyCursor },
            });
          assert.deepEqual(tailPg2, tailSq2);
          assert.equal(tailPg2.done, true);

          const followPg = readObserveEventTail({
              repoId,
              rootDir,
              mode: "local",
              projection: pgQueries,
              payload: { kind: "events", direction: "follow", cursor: { kind: "events", revision: 60 } },
            }),
            followSq = readObserveEventTail({
              repoId,
              rootDir,
              mode: "local",
              projection: sqlite,
              payload: { kind: "events", direction: "follow", cursor: { kind: "events", revision: 60 } },
            });
          assert.deepEqual(followPg, followSq);

          assert.throws(
            () =>
              readObserveEventTail({
                repoId,
                rootDir,
                mode: "local",
                projection: pgQueries,
                payload: {
                  kind: "events",
                  direction: "history",
                  cursor: { kind: "events", revision: loneSurrogateEvent.workspaceRevision + 5 },
                },
              }),
            (error) => error?.code === "invalid_cursor",
          );
        });
      };

      // 1. Live + cold-rebuild populated state matches SQLite.
      assertParity();

      // 2. Simulate pre-upgrade rows (default_summary_json = NULL). Default/workspace reads
      // fail closed until the production management entry drains the bounded pages.
      await withPostgresTransaction(
        pgFixture.pool,
        async (client) => {
          await client.query(
            "UPDATE ha_events SET default_summary_json = NULL WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4",
            [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
          );
          await client.query(
            "DELETE FROM ha_event_summary_state WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4",
            [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
          );
        },
        scope,
      );
      pgReader.withSession((pgQueries) => {
        assert.throws(() => pgQueries.readEventSummaries(0, 200), { code: "projection_pending" });
        assert.throws(() => pgQueries.readEventSummaries(0, 200, { taskIds: ["task_alpha"] }), {
          code: "projection_pending",
        });
      });

      await backfillPgDefaultEventSummaries(pgFixture.pool, scope, repoId);
      assertParity();

      await withPostgresTransaction(
        pgFixture.pool,
        async (client) => {
          await client.query(
            "UPDATE ha_events SET default_summary_json = NULL WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4",
            [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
          );
        },
        scope,
      );
      const page1 = await withPostgresTransaction(
        pgFixture.pool,
        (client) => backfillPgDefaultEventSummariesPage(client, scope, repoId),
        scope,
      );
      assert.deepEqual(page1, { processed: 64, done: false });
      const page2 = await withPostgresTransaction(
        pgFixture.pool,
        (client) => backfillPgDefaultEventSummariesPage(client, scope, repoId),
        scope,
      );
      assert.equal(page2.processed, allEvents.length - 64);
      assert.equal(page2.done, false);
      const page3 = await withPostgresTransaction(
        pgFixture.pool,
        (client) => backfillPgDefaultEventSummariesPage(client, scope, repoId),
        scope,
      );
      assert.deepEqual(page3, { processed: 0, done: true });

      const remainingPending = await withPostgresTransaction(
        pgFixture.pool,
        (client) =>
          client.query(
            "SELECT count(*)::integer AS count FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 AND default_summary_json IS NULL",
            [scope.tenantId, scope.projectId, scope.policyEpoch, repoId],
          ),
        scope,
      );
      assert.equal(remainingPending.rows[0].count, 0);
      assertParity();

      // 3. Updating event_json directly refreshes default_summary_json in the same trigger
      // transaction, so the ready serving path never needs to reread the canonical body.
      const updatedEvent = {
        ...loneSurrogateEvent,
        payload: { ...loneSurrogateEvent.payload, statement: "Updated fact statement" },
      };
      await withPostgresTransaction(
        pgFixture.pool,
        (client) =>
          client.query(
            "UPDATE ha_events SET event_json = $5 WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 AND revision=$6",
            [
              scope.tenantId,
              scope.projectId,
              scope.policyEpoch,
              repoId,
              serializeCanonicalEventUnchecked(updatedEvent).trimEnd(),
              loneSurrogateEvent.workspaceRevision,
            ],
          ),
        scope,
      );
      const invalidated = await withPostgresTransaction(
        pgFixture.pool,
        (client) =>
          client.query(
            "SELECT default_summary_json FROM ha_events WHERE tenant_id=$1 AND project_id=$2 AND policy_epoch=$3 AND repo_id=$4 AND revision=$5",
            [scope.tenantId, scope.projectId, scope.policyEpoch, repoId, loneSurrogateEvent.workspaceRevision],
          ),
        scope,
      );
      assert.deepEqual(
        canonicalEventSummary(JSON.parse(invalidated.rows[0].default_summary_json)),
        canonicalEventSummary(normalizeHistoricalEvent(updatedEvent)),
      );
      pgReader.withSession((pgQueries) => {
        const refreshed = pgQueries
          .readEventSummaries(0, 200)
          .events.find((item) => item.eventId === loneSurrogateEvent.eventId);
        assert.equal(refreshed.payload.statement, "Updated fact statement");
      });
    } finally {
      pgReader?.close();
      sqlite?.close();
      await pgFixture.pool.end();
      await pgFixture.close();
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  test(
    "native PostgreSQL original-scale event reads stay bounded for previous-writer summary input",
    { skip: process.env.FLEET_STRESS_G38_READ_SCALES !== "1" },
    async (t) => {
      const measurements = {};
      for (const [dimension, scales, probeId] of [
        ["event-bytes", READ_SCALES, "event-tail"],
        ["task-outputs", READ_OUTPUT_SCALES, "repo.workspace.scope.read"],
      ]) {
        const pair = {};
        for (const [scale, size] of Object.entries(scales)) {
          pair[scale] = await tracePgProbe(dimension, size, probeId, "postgres");
        }
        measurements[dimension] = pair;
        t.diagnostic(JSON.stringify({ nativePostgres: dimension, measurements: pair }));
        assert.equal(pair.small.resultSize, pair.large.resultSize);
        for (const phase of ["counts", "firstCall"]) {
          for (const [metric, margin] of Object.entries(READ_MARGINS)) {
            assert.ok(
              pair.large[phase][metric] <= pair.small[phase][metric] + margin,
              `${probeId}/${phase}/${metric}: ${pair.small[phase][metric]} -> ${pair.large[phase][metric]}`,
            );
          }
        }
        for (const phase of ["firstStatements", "warmStatements"]) {
          const summaryQueries = pair.large[phase].filter(({ sql }) =>
            sql.includes("default_summary_json AS summary_json"),
          );
          assert.equal(summaryQueries.length, 1);
          for (const { sql } of pair.large[phase]) assert.doesNotMatch(sql, /\bevent_json\b/u);
        }
        if (dimension === "task-outputs") {
          const query = pair.large.warmStatements.find(({ sql }) => sql.includes("canonical_task_id = $6"));
          const scan = query.scanNodes.find(({ indexCond }) => indexCond?.includes("canonical_task_id ="));
          assert.ok(scan, "workspace event page must use the canonical-task equality index");
          assert.equal(scan.rowsRemovedByFilter, 0);
        }
      }
      assert.equal(
        measurements["event-bytes"].large.counts.sqlResultBytes,
        measurements["event-bytes"].small.counts.sqlResultBytes,
      );
      assert.equal(
        measurements["task-outputs"].large.counts.sqlRowsRead,
        measurements["task-outputs"].small.counts.sqlRowsRead,
      );
    },
  );

  test(
    "R8 event-tail (event-bytes) and R9 repo.workspace.scope.read (task-outputs) have zero PGlite scale growth and use bounded plans",
    {
      skip:
        Number(process.versions.node.split(".")[0]) < 26
          ? "G38 PGlite measurement is pinned to Node 26; cost-budget-reads runs on Node 26"
          : false,
    },
    async (t) => {
      const fullScale = process.env.FLEET_STRESS_G38_READ_SCALES === "1";

      // 1. R8: event-tail on event-bytes at full 200 -> 2000 with zero exemptions.
      const eventTailPair = {};
      for (const [scale, size] of Object.entries(READ_SCALES)) {
        eventTailPair[scale] = (await measureReadScale("pglite", "event-bytes", size, { probeIds: ["event-tail"] }))[
          "event-tail"
        ];
      }
      const eventTailEval = evaluateReadMeasurements({
        section: {
          schema: "read-cost-scaling-budget/v1",
          knownScaling: [],
          readCoverage: {
            measured: { "method:observe.tail": { measurements: ["event-tail"] } },
            notApplicable: [],
          },
        },
        inventory: [{ id: "method:observe.tail" }],
        probes: { "event-tail": READ_PROBES["event-tail"] },
        backends: ["pglite"],
        dimensions: ["event-bytes"],
        measured: { pglite: { "event-bytes": { "event-tail": eventTailPair } } },
      });
      assert.deepEqual(eventTailEval.errors, []);
      assert.equal(eventTailEval.ok, true);
      assert.equal(eventTailPair.large.counts.sqlResultBytes - eventTailPair.small.counts.sqlResultBytes, 0);
      assert.equal(eventTailPair.large.firstCall.sqlResultBytes - eventTailPair.small.firstCall.sqlResultBytes, 0);

      // 2. R9: repo.workspace.scope.read on task-outputs at 340 -> 3400 (plus full 3400 -> 34000 when FLEET_STRESS_G38_READ_SCALES=1).
      const outputScales = fullScale ? READ_OUTPUT_SCALES : { small: 340, large: 3400 };
      const scopePair = {};
      for (const [scale, size] of Object.entries(outputScales)) {
        scopePair[scale] = (
          await measureReadScale("pglite", "task-outputs", size, { probeIds: ["repo.workspace.scope.read"] })
        )["repo.workspace.scope.read"];
      }
      assert.equal(scopePair.small.resultSize, scopePair.large.resultSize);
      for (const phase of ["counts", "firstCall"]) {
        for (const [metric, margin] of Object.entries(READ_MARGINS)) {
          assert.ok(
            scopePair.large[phase][metric] <= scopePair.small[phase][metric] + margin,
            `repo.workspace.scope.read (${phase}.${metric}): ${scopePair.small[phase][metric]} -> ${scopePair.large[phase][metric]} exceeded +${margin}`,
          );
        }
      }
      assert.equal(scopePair.large.counts.sqlRowsRead - scopePair.small.counts.sqlRowsRead, 0);
      assert.equal(scopePair.large.firstCall.sqlRowsRead - scopePair.small.firstCall.sqlRowsRead, 0);

      let sqliteControl = null;
      if (fullScale) {
        const sqliteTailPair = {};
        for (const [scale, size] of Object.entries(READ_SCALES)) {
          sqliteTailPair[scale] = (await measureReadScale("sqlite", "event-bytes", size, { probeIds: ["event-tail"] }))[
            "event-tail"
          ];
        }
        const sqliteScopePair = {};
        for (const [scale, size] of Object.entries(READ_OUTPUT_SCALES)) {
          sqliteScopePair[scale] = (
            await measureReadScale("sqlite", "task-outputs", size, { probeIds: ["repo.workspace.scope.read"] })
          )["repo.workspace.scope.read"];
        }
        sqliteControl = { sqliteTailPair, sqliteScopePair };
        const scopeEval = evaluateReadMeasurements({
          section: {
            schema: "read-cost-scaling-budget/v1",
            knownScaling: [],
            readCoverage: {
              measured: { "method:repo.workspace.scope.read": { measurements: ["repo.workspace.scope.read"] } },
              notApplicable: [],
            },
          },
          inventory: [{ id: "method:repo.workspace.scope.read" }],
          probes: { "repo.workspace.scope.read": READ_PROBES["repo.workspace.scope.read"] },
          backends: ["sqlite", "pglite"],
          dimensions: ["task-outputs"],
          measured: {
            sqlite: { "task-outputs": { "repo.workspace.scope.read": sqliteScopePair } },
            pglite: { "task-outputs": { "repo.workspace.scope.read": scopePair } },
          },
        });
        assert.deepEqual(scopeEval.errors, []);
        assert.equal(scopeEval.ok, true);
      }

      // 3. Per-statement SQL & EXPLAIN (ANALYZE, FORMAT JSON, TIMING OFF) plan proof.
      const tailTraceSmall = await tracePgProbe("event-bytes", 200, "event-tail");
      const tailTraceLarge = await tracePgProbe("event-bytes", 2000, "event-tail");
      const tailEventSelects = tailTraceLarge.warmStatements.filter((stmt) =>
        stmt.sql.includes("default_summary_json AS summary_json"),
      );
      assert.equal(tailEventSelects.length, 1, "history event-tail must read ha_events summaries once per call");
      assert.equal(tailTraceLarge.counts.sqlResultBytes, tailTraceSmall.counts.sqlResultBytes);

      const scopeTraceSmall = await tracePgProbe("task-outputs", outputScales.small, "repo.workspace.scope.read");
      const scopeTraceLarge = await tracePgProbe("task-outputs", outputScales.large, "repo.workspace.scope.read");
      const canonicalTaskSelect = scopeTraceLarge.warmStatements.find((stmt) =>
        stmt.sql.includes("canonical_task_id = $6"),
      );
      assert.ok(canonicalTaskSelect, "workspace scope read must query canonical_task_id");
      const canonicalScan = canonicalTaskSelect.scanNodes.find((node) => node.relationName === "ha_events");
      assert.ok(canonicalScan?.indexCond?.includes("canonical_task_id ="));
      assert.equal(canonicalScan?.rowsRemovedByFilter, 0);

      t.diagnostic(
        JSON.stringify({
          postFix: {
            fullScale,
            eventTailPair,
            scopePair,
            sqliteControl,
            tailTraceSmall: {
              firstCall: tailTraceSmall.firstCall,
              counts: tailTraceSmall.counts,
              warmStatements: tailTraceSmall.warmStatements,
            },
            tailTraceLarge: {
              firstCall: tailTraceLarge.firstCall,
              counts: tailTraceLarge.counts,
              warmStatements: tailTraceLarge.warmStatements,
            },
            scopeTraceSmall: {
              size: scopeTraceSmall.size,
              firstCall: scopeTraceSmall.firstCall,
              counts: scopeTraceSmall.counts,
            },
            scopeTraceLarge: {
              size: scopeTraceLarge.size,
              firstCall: scopeTraceLarge.firstCall,
              counts: scopeTraceLarge.counts,
              canonicalTaskSelect,
            },
          },
        }),
      );
    },
  );
}

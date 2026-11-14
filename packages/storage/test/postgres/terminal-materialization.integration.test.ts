// harness-test-tier: integration
import test from "node:test";
import assert from "node:assert/strict";
import { canonicalEventCut } from "@harness-anything/kernel";
import {
  DOC_CODEC_ID,
  DOC_POLICY_ID,
  docSyncWritePlan,
  type DocumentState,
  type DocEventV1,
} from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import { getPgProjectionValue } from "../../src/pg/pg-projection-values.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { materializePgProjectionEvent, rebuildPgProjection } from "../../src/pg/pg-task-event-materialize.ts";
import { createPgStorageBackend } from "../../src/pg/backend.ts";
import { pgRuntimeFixture } from "./pg-runtime.fixture.ts";
import { archivedFactUpgradeHistory, assertTerminalMaterialization } from "../terminal-materialization.fixture.ts";
import {
  initializePgTerminalMaterialization,
  materializePgQueryModels,
} from "../../src/pg/pg-query-model-materialize.ts";
import { bundle, eventAt } from "../store/task-event-store.fixtures.ts";

test("PostgreSQL nonterminal document writes do no history, subtree or hold work", async () => {
  const fixture = await pgRuntimeFixture(),
    repoId = "document-write-cost",
    scope = { tenantId: "documents", projectId: "cost", policyEpoch: 0, readers: [] },
    backend = createPgStorageBackend({ pool: fixture.pool, repoId, scope }),
    created = eventAt(1),
    maintenanceQueries: string[] = [];
  fixture.pool.on("connect", (client) => {
    client.query = new Proxy(client.query, {
      apply(target, receiver, args) {
        if (args[1]?.[3] === "materialization-index") maintenanceQueries.push(args[0]);
        return Reflect.apply(target, receiver, args);
      },
    });
  });
  try {
    await backend.eventStore.append(bundle(created), 0, { repoId, holderId: "fixture", epoch: 1 });
    let baseLedgerSha = await backend.eventStore.currentCut();
    const documents = [2, 3].map((revision) => {
      const body = `# Batch ${revision}\n`,
        sha256 = sha256Text(body),
        candidate = { sha256, size: Buffer.byteLength(body), mediaType: "text/markdown" },
        event: DocEventV1 = {
          schema: "doc-event/v1",
          type: "documents_written",
          eventId: `batch-${revision}`,
          opId: `batch-${revision}`,
          workspaceRevision: revision,
          actor: created.actor,
          source: created.source,
          occurredAt: created.occurredAt,
          payload: {
            executionId: "fixture",
            baseLedgerSha,
            changes: [
              {
                path: `tasks/${created.taskId}-replay-task/artifacts/batch-${revision}.md`,
                baseBlobSha256: null,
                policyId: DOC_POLICY_ID,
                candidate,
                regionProofs: [
                  {
                    regionId: "heading/shared",
                    policyId: DOC_POLICY_ID,
                    codecId: DOC_CODEC_ID,
                    baseSha256: sha256Text(""),
                    candidateSha256: sha256,
                    insertBytes: Buffer.byteLength(body),
                  },
                ],
              },
            ],
          },
        };
      const { opId: _opId, ...nextCut } = canonicalEventCut(repoId, event);
      baseLedgerSha = nextCut;
      return { event, plan: docSyncWritePlan(event), blobs: [{ ...candidate, body }] };
    });
    maintenanceQueries.length = 0;
    await backend.eventStore.append({ ...documents[1]!, preceding: [documents[0]!] }, 1, {
      repoId,
      holderId: "fixture",
      epoch: 1,
    });
    assert.equal(maintenanceQueries.length, 2, "completed materialization indexes are checked once per batch");
    const currentCut = await backend.eventStore.currentCut();
    await withPostgresTransaction(
      fixture.pool,
      async (client) => {
        const row = await client.query<{ package_path: string }>(
          "SELECT package_path FROM ha_task_snapshots WHERE tenant_id=$1 AND project_id=$2 AND task_id=$3",
          [scope.tenantId, scope.projectId, created.taskId],
        );
        for (const [index, status] of ["planned", "active", "done"].entries()) {
          // Exercise the read-model boundary in every nonterminal materialization state;
          // lifecycle acceptance and terminal unlocks have the full contract below.
          await client.query(
            "UPDATE ha_task_snapshots SET snapshot=jsonb_set(snapshot,'{task,status}',to_jsonb($4::text)),task_status=$4 WHERE tenant_id=$1 AND project_id=$2 AND task_id=$3",
            [scope.tenantId, scope.projectId, created.taskId, status],
          );
          const path = `${row.rows[0]!.package_path}/artifacts/${status}.md`,
            body = `# ${status}\n`,
            sha256 = sha256Text(body),
            event: DocEventV1 = {
              schema: "doc-event/v1",
              type: "documents_written",
              eventId: `doc-${status}`,
              opId: `doc-${status}`,
              workspaceRevision: index + 4,
              actor: created.actor,
              source: created.source,
              occurredAt: created.occurredAt,
              payload: {
                executionId: "fixture",
                baseLedgerSha: currentCut,
                changes: [
                  {
                    path,
                    baseBlobSha256: null,
                    policyId: "document/v1",
                    candidate: { sha256, size: Buffer.byteLength(body), mediaType: "text/markdown" },
                    regionProofs: [],
                  },
                ],
              },
            },
            queries: string[] = [],
            observed = new Proxy(client, {
              get(target, key) {
                if (key === "query")
                  return (sql: string, values?: unknown[]) => {
                    queries.push(`${sql} ${JSON.stringify(values)}`);
                    return target.query(sql, values);
                  };
                return Reflect.get(target, key);
              },
            });
          await materializePgQueryModels(
            observed,
            scope,
            // Canonical batches accumulate artifact writes for one outer flush.
            { event, artifacts: new Map(), readContentBlob: () => Buffer.from(body) },
            null,
          );
          assert.equal(queries.length, 2, `${status}: only document upsert and indexed task eligibility lookup`);
          assert.ok(
            queries.every((sql) => !/document-history|materialization-hold|ha_relations/u.test(sql)),
            queries.join("\n"),
          );
          assert.equal((await getPgProjectionValue<DocumentState>(client, scope, "document", path))?.body, body);
          assert.equal(await getPgProjectionValue(client, scope, "document-history", path), null);
        }
      },
      scope,
    );
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});

test("PostgreSQL terminal documents retain canonical holds and unlock incrementally", async () => {
  const fixture = await pgRuntimeFixture(),
    repoId = "terminal-materialization",
    scope = { tenantId: "terminal", projectId: "materialization", policyEpoch: 0, readers: [] },
    backend = createPgStorageBackend({
      pool: fixture.pool,
      repoId,
      scope,
    });
  let revision = 0;
  try {
    await assertTerminalMaterialization({
      append: async (bundle) => {
        await backend.eventStore.append(bundle, revision, { repoId, holderId: "fixture", epoch: 1 });
        revision++;
      },
      replayAcceptedDocument: (bundle) =>
        withPostgresTransaction(
          fixture.pool,
          (client) =>
            materializePgProjectionEvent(client, scope, {
              event: bundle.event,
              readContentBlob: (sha256) => {
                const blob = bundle.blobs.find((entry) => entry.sha256 === sha256);
                return blob ? Buffer.from(blob.body) : null;
              },
            }),
          scope,
        ),
      // Historical replay advances A3 beyond this fixture's accepting store. Inspect its rows
      // directly; public reads correctly refuse a projection cut ahead of the canonical ledger.
      document: (path) =>
        withPostgresTransaction(
          fixture.pool,
          (client) => getPgProjectionValue<DocumentState>(client, scope, "document", path),
          scope,
        ),
      history: (path) =>
        withPostgresTransaction(
          fixture.pool,
          (client) => getPgProjectionValue<DocumentState>(client, scope, "document-history", path),
          scope,
        ),
      fact: async (id) => (await backend.projection.readFact(id)).fact,
      decision: async (id) => (await backend.projection.readDecision(id)).decision,
    });
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});

test("PostgreSQL archived Facts survive warm upgrade and preserve cold history", async () => {
  const fixture = await pgRuntimeFixture(),
    scope = { tenantId: "warm", projectId: "history", policyEpoch: 0, readers: [] },
    repoId = "archived-fact-upgrade",
    backend = createPgStorageBackend({ pool: fixture.pool, repoId, scope }),
    paths = ["facts/F-00000010.md", "facts/F-00000011.md"];
  try {
    let revision = 0;
    for (const bundle of archivedFactUpgradeHistory()) {
      await backend.eventStore.append(bundle, revision, { repoId, holderId: "fixture", epoch: 1 });
      revision++;
    }
    const history = () =>
        Promise.all(paths.map((path) => backend.projection.readDocumentHistory(path).then((read) => read.document))),
      expected = await history();
    await withPostgresTransaction(
      fixture.pool,
      async (client) => {
        await client.query(
          "DELETE FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND model IN ('document-history','materialization-index')",
          [scope.tenantId, scope.projectId],
        );
      },
      scope,
    );
    await assert.rejects(
      withPostgresTransaction(
        fixture.pool,
        async (client) => {
          await client.query("DELETE FROM ha_content_blobs WHERE tenant_id=$1 AND project_id=$2 AND sha256=$3", [
            scope.tenantId,
            scope.projectId,
            expected[0]!.blobSha256,
          ]);
          await initializePgTerminalMaterialization(client, scope, revision);
        },
        scope,
      ),
      /projection document blob .* is unavailable/u,
    );
    await withPostgresTransaction(
      fixture.pool,
      async (client) => {
        const partial = await client.query(
          "SELECT 1 FROM ha_projection_values WHERE tenant_id=$1 AND project_id=$2 AND model='document-history'",
          [scope.tenantId, scope.projectId],
        );
        assert.equal(partial.rows.length, 0, "partial recovery rolls back");
        assert.equal(
          await getPgProjectionValue(client, scope, "materialization-index", "history-v1"),
          null,
          "failed recovery never commits its marker",
        );
        await initializePgTerminalMaterialization(client, scope, revision);
      },
      scope,
    );
    assert.deepEqual(await history(), expected);
    await withPostgresTransaction(
      fixture.pool,
      (client) => initializePgTerminalMaterialization(client, scope, revision),
      scope,
    );
    assert.deepEqual(await history(), expected, "upgrade is idempotent");
    assert.ok(
      (await Promise.all(paths.map((path) => backend.projection.readDocument(path)))).every(
        (read) => read.document === null,
      ),
    );
    await withPostgresTransaction(
      fixture.pool,
      (client) =>
        rebuildPgProjection(client, scope, {
          events: archivedFactUpgradeHistory().map(({ event }) => event),
          sourceRevision: revision,
          readContentBlob: async (sha256) =>
            (
              await client.query<{ body: Buffer }>(
                "SELECT body FROM ha_content_blobs WHERE tenant_id=$1 AND project_id=$2 AND sha256=$3",
                [scope.tenantId, scope.projectId, sha256],
              )
            ).rows[0]?.body ?? null,
        }),
      scope,
    );
    assert.deepEqual(await history(), expected, "warm and cold histories agree");
  } finally {
    await fixture.pool.end();
    await fixture.close();
  }
});

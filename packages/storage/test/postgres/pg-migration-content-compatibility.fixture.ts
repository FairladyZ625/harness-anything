import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { serializePersistedCanonicalEvent } from "@harness-anything/kernel/internal/domain/doc-sync.contract.ts";
import { withPostgresTransaction } from "../../src/postgres/transaction.ts";
import { createPgStorageBackend } from "../../src/pg/backend.ts";
import { rebuildPgProjection } from "../../src/pg/pg-task-event-materialize.ts";
import { getPgProjectionValue, listPgProjectionValues } from "../../src/pg/pg-projection-values.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { appendRuntimeQueryFixtures } from "./pg-runtime-query-parity.fixture.ts";
import { bundle, docBundle, eventAt, initRepo } from "../store/task-event-store.fixtures.ts";

export const repoId = "migration-content-probe",
  scope = { tenantId: "tenant-content", projectId: "project-content", readers: ["reader-a"], policyEpoch: 0 };

export async function assertContentParity(pool: Pool, backend: string): Promise<void> {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-pg-migration-content-"));
  initRepo(rootDir);
  const sqlite = makeTaskEventStore({ repoId, rootDir }),
    projection = makeTaskProjection({ rootDir, eventStore: sqlite }),
    pg = createPgStorageBackend({ pool, repoId, scope }),
    fence = { repoId, holderId: "content-probe-writer", epoch: 1 };
  try {
    const created = eventAt(1),
      initial = bundle({
        ...created,
        taskId: "task-parity",
        payload: {
          task: { ...created.payload.task, taskId: "task-parity" },
        },
      });
    sqlite.append(initial);
    await pg.eventStore.append(initial, 0, fence);
    for (const [index, body] of [
      "Unicode 台账\nnormal content\n",
      "Unicode 台账\n\0bytes\n",
      "\0\0prefix\\u0000 literal\\n\u0001😀e\u0301\0suffix\0",
    ].entries()) {
      const revision = index + 2,
        candidate = docBundle(sqlite, body, revision, `op-content-${revision}`, "docs/content.md");
      // The ordinary canonical writer admits these bytes; no raw SQL seeds the source.
      sqlite.append(candidate);
      projection.catchUp();
      assert.equal(projection.readDocument("docs/content.md").document!.body, body);
      await pg.eventStore.append(candidate, revision - 1, fence);
      assert.deepEqual(await pg.eventStore.currentCut(), sqlite.currentCut());
      const stored = await pg.projection.readDocument("docs/content.md");
      assert.deepEqual(stored, projection.readDocument("docs/content.md"));
      assert.deepEqual(Buffer.from(stored.document!.body), Buffer.from(body));
      assert.deepEqual(await pg.projection.readDocuments("docs/"), projection.readDocuments("docs/"));
      assert.deepEqual(await pg.projection.readReplicaBasis(0), projection.readReplicaBasis(0));
      const raw = (
        await pool.query<{ event_json: string }>("SELECT event_json FROM ha_events WHERE repo_id=$1 AND revision=$2", [
          repoId,
          revision,
        ])
      ).rows[0]!;
      assert.equal(raw.event_json, serializePersistedCanonicalEvent(candidate.event));
      assert.deepEqual(
        Buffer.from(
          (await pg.eventStore.execute({ operation: "content", sha256: candidate.blobs[0]!.sha256 })) as Uint8Array,
        ),
        Buffer.from(body),
      );
      assert.ok(await pg.eventStore.execute({ operation: "outcome", opId: candidate.event.opId }));
      process.stdout.write(
        `CONTENT_PARITY ${backend}/SQLite revision=${revision} bytes=${Buffer.byteLength(body)} headDigest=${sqlite.currentCut().headDigest}\n`,
      );
    }
    await withPostgresTransaction(
      pool,
      async (client) => {
        const hiddenScope = { ...scope, readers: ["reader-b"] };
        assert.equal(await getPgProjectionValue(client, hiddenScope, "document", "docs/content.md"), null);
        assert.deepEqual(await listPgProjectionValues(client, hiddenScope, "document"), []);
      },
      scope,
    );
    let revision = 5;
    await appendRuntimeQueryFixtures(
      async (candidate) => {
        sqlite.append(candidate);
        await pg.eventStore.append(candidate, revision - 1, fence);
        revision++;
      },
      () => revision,
    );
    projection.catchUp();
    const assertRuntimeQueries = async () => {
      assert.deepEqual(
        await pg.projection.getEntity("runtime-session", "runtime-query-session"),
        projection.getEntity("runtime-session", "runtime-query-session"),
      );
      assert.deepEqual(
        await pg.projection.readRuntimeSessionPage({ limit: 1 }),
        projection.readRuntimeSessionPage({ limit: 1 }),
      );
      assert.deepEqual(
        await pg.projection.readTaskRuntimeBatch({ taskIds: ["task-parity", "missing"] }),
        projection.readTaskRuntimeBatch({ taskIds: ["task-parity", "missing"] }),
      );
      assert.deepEqual(
        await pg.projection.readRuntimeDispatchesByMember({ agentId: "parity-agent", limit: 1 }),
        projection.readRuntimeDispatchesByMember({ agentId: "parity-agent", limit: 1 }),
      );
    };
    await assertRuntimeQueries();
    const beforeDigest = await pg.projection.readStateDigest(),
      events = sqlite.read().events;
    assert.match(beforeDigest!, /^sha256:[a-f0-9]{64}$/u);
    await withPostgresTransaction(
      pool,
      (client) =>
        rebuildPgProjection(client, scope, {
          events,
          sourceRevision: events.at(-1)!.workspaceRevision,
          readContentBlob: (sha256) => sqlite.readContentBlob(sha256),
        }),
      scope,
    );
    assert.deepEqual(await pg.projection.readDocument("docs/content.md"), projection.readDocument("docs/content.md"));
    assert.deepEqual(await pg.projection.readDocuments("docs/"), projection.readDocuments("docs/"));
    assert.equal(
      await pg.projection.readStateDigest(),
      beforeDigest,
      "cold replay retains the complete projection digest",
    );
    await assertRuntimeQueries();
    process.stdout.write(`CONTENT_REPLAY ${backend} document, queries, readers and digest match\n`);
  } finally {
    projection.close();
    await sqlite.drain();
    await pg.projection.close();
    await pg.entities.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
}

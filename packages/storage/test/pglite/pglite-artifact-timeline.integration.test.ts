// harness-test-tier: integration
import assert from "node:assert/strict";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import test from "node:test";
import {
  artifactRetirementEntry,
  artifactTimelineDdl,
  backfillPgArtifactDocuments,
  flushPgArtifactDocuments,
  projectPgArtifactDocument,
  readPgArtifactTimeline,
} from "../../src/pg/pg-artifact-timeline.ts";
import { createPGliteStorageBackend } from "../../src/pglite/storage-backend.ts";
import { makeTaskProjection } from "../../src/projection/rebuildable-task-projection.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { docBundle } from "../store/task-event-store.fixtures.ts";
import { withTempStoreAsync } from "../store/helpers.ts";
import { pgliteIntegrationSuite } from "./pglite-runtime.fixture.ts";

const base = { tenantId: "t", projectId: "p", policyEpoch: 1 },
  html = { mediaType: "text/html", policyId: "opaque-textual-whole-file/v1", size: 7 },
  markdown = { mediaType: "text/markdown", policyId: "markdown-body-replaceable/v1", size: 9 };

async function createTimelineSchema(db: PGlite): Promise<void> {
  await db.exec(`
    CREATE TABLE ha_events(tenant_id text, project_id text, repo_id text, revision bigint, occurred_at text,
      PRIMARY KEY(tenant_id,project_id,repo_id,revision));
    CREATE TABLE ha_projection_values(tenant_id text, project_id text, policy_epoch bigint, model text,
      entity_id text, owner_id text, workspace_revision bigint, value text, document_metadata text,
      readers text[] NOT NULL DEFAULT '{}', PRIMARY KEY(tenant_id,project_id,policy_epoch,model,owner_id,entity_id));
    CREATE TABLE ha_task_snapshots(tenant_id text, project_id text, policy_epoch bigint, task_id text,
      workspace_revision bigint, snapshot jsonb, package_path text, readers text[] NOT NULL DEFAULT '{}',
      PRIMARY KEY(tenant_id,project_id,policy_epoch,task_id));
    CREATE TABLE ha_projection_meta(tenant_id text, project_id text, policy_epoch bigint,
      projection_name text, artifact_index_version smallint NOT NULL DEFAULT 0,
      PRIMARY KEY(tenant_id,project_id,policy_epoch,projection_name));
  `);
  for (const statement of artifactTimelineDdl()) await db.exec(statement);
}

pgliteIntegrationSuite("PGlite artifact timeline index", () => {
  test("readers isolate rows and totals, the relative path is package-relative, and readiness gates a partial index", async () => {
    const db = await PGlite.create();
    const client = { query: (text: string, values?: unknown[]) => db.query(text, values) };
    try {
      await createTimelineSchema(db);
      const scopeA = { ...base, readers: ["a"] },
        scopeB = { ...base, readers: ["b"] },
        scopeAll = { ...base, readers: [] as string[] };
      await projectPgArtifactDocument(client, scopeA, "tasks/pkg-a/artifacts/a.html", html, "2026-08-01T00:00:00.000Z");
      await projectPgArtifactDocument(client, scopeB, "tasks/pkg-a/artifacts/b.html", html, "2026-08-02T00:00:00.000Z");
      const pageA = await readPgArtifactTimeline(client, scopeA, { kind: "html", limit: 10 });
      assert.deepEqual(
        pageA.rows.map(({ relative }) => relative),
        ["artifacts/a.html"],
        "the stored path keeps the artifacts/ prefix shared with SQLite and the backfill",
      );
      assert.deepEqual(pageA.counts, { html: 1, md: 0, raw: 0 }, "A counts only A's doc");
      const pageB = await readPgArtifactTimeline(client, scopeB, { kind: "html", limit: 10 });
      assert.deepEqual(
        pageB.rows.map(({ relative }) => relative),
        ["artifacts/b.html"],
      );
      assert.deepEqual(pageB.counts, { html: 1, md: 0, raw: 0 });
      const pageAll = await readPgArtifactTimeline(client, scopeAll, { kind: "html", limit: 10 });
      assert.equal(pageAll.rows.length, 2);
      assert.deepEqual(pageAll.counts, { html: 2, md: 0, raw: 0 }, "an unscoped reader sees both rows and their total");

      // A cache that predates the index must refuse instead of reporting a partial timeline ready.
      await db.query(`INSERT INTO ha_projection_meta VALUES ('t','p',1,'task/v1',0)`);
      await assert.rejects(() => readPgArtifactTimeline(client, scopeA, { kind: "html", limit: 1 }), {
        code: "projection_pending",
      });

      // The one-time expansion reconstructs both rows and per-reader counts from projected documents.
      await db.exec(
        "DELETE FROM ha_artifact_documents; DELETE FROM ha_artifact_counts; DELETE FROM ha_projection_meta",
      );
      await db.query(`INSERT INTO ha_events VALUES ('t','p','repo',1,'2026-08-03T00:00:00.000Z')`);
      await db.query(
        `INSERT INTO ha_projection_values VALUES ('t','p',1,'document','tasks/pkg-a/artifacts/old.html','',1,$1,$2,$3)`,
        [
          "x",
          JSON.stringify({
            path: "tasks/pkg-a/artifacts/old.html",
            size: 9,
            mediaType: "text/html",
            policyId: "opaque-textual-whole-file/v1",
          }),
          ["a"],
        ],
      );
      await db.query(`INSERT INTO ha_projection_meta VALUES ('t','p',1,'task/v1',0)`);
      assert.equal(await backfillPgArtifactDocuments(client, base, "repo"), 1);
      const backfilled = await readPgArtifactTimeline(client, scopeA, { kind: "html", limit: 10 });
      assert.deepEqual(
        backfilled.rows.map(({ relative }) => relative),
        ["artifacts/old.html"],
      );
      assert.deepEqual(backfilled.counts, { html: 1, md: 0, raw: 0 });
      assert.equal((await readPgArtifactTimeline(client, scopeB, { kind: "html", limit: 10 })).rows.length, 0);
    } finally {
      await db.close();
    }
  });

  test("catch-up backfills a pre-index projection before serving and a cold rebuild discards dirty rows", async () => {
    await withTempStoreAsync(async (rootDir) => {
      const repoId = "pglite-artifact-timeline",
        storage = {
          backend: "pglite" as const,
          dataDir: join(rootDir, "database"),
          materialize: false,
          scope: { tenantId: "t", projectId: "p", policyEpoch: 1 },
        },
        target = "tasks/task-artifact-fixture/artifacts/parity.md";
      const open = () => {
        const store = makeTaskEventStore({ repoId, rootDir, storage }),
          projection = makeTaskProjection({ rootDir, eventStore: store, storage });
        return { store, projection };
      };
      const first = open();
      try {
        first.store.append(docBundle(first.store, "# Parity artifact\n", 1, "artifact-one", target));
        const page = first.projection.readArtifactTimelinePage({ kind: "md", limit: 10 });
        assert.deepEqual(
          page.rows.map(({ relative }) => relative),
          ["artifacts/parity.md"],
        );
        assert.deepEqual(page.counts, { html: 0, md: 1, raw: 0 });
      } finally {
        first.projection.close();
        await first.store.drain();
      }
      const backend = await createPGliteStorageBackend({ repoId, storage });
      try {
        await backend.pool.query(
          `INSERT INTO ha_artifact_documents
             (tenant_id, project_id, policy_epoch, all_readers, reader, readers, path, package_dir, relative, kind, sort_ms, occurred_at, size_bytes)
           VALUES ('t','p',1,true,'','{}','tasks/task-x/artifacts/bogus.html','task-x','artifacts/bogus.html','html',-1,'2026-08-01T00:00:00.000Z',7)`,
        );
        await backend.pool.query("UPDATE ha_artifact_counts SET total=99 WHERE kind='md'");
        await backend.pool.query("UPDATE ha_projection_meta SET artifact_index_version=0");
      } finally {
        await backend.close();
      }
      const second = open();
      try {
        // Opening the embedded backend runs the one-time expansion before readers are admitted,
        // so a version-0 cache is repaired rather than served as a partial timeline. The direct
        // read-level pending case is covered by the first test.
        const repaired = second.projection.readArtifactTimelinePage({ kind: "md", limit: 10 });
        assert.deepEqual(
          repaired.rows.map(({ relative }) => relative),
          ["artifacts/parity.md"],
        );
        assert.deepEqual(repaired.counts, { html: 0, md: 1, raw: 0 });
        assert.equal(
          second.projection.readArtifactTimelinePage({ kind: "html", limit: 10 }).rows.length,
          0,
          "the initialization backfill removes the dirty row",
        );
      } finally {
        second.projection.close();
        await second.store.drain();
      }
      const dirty = await createPGliteStorageBackend({ repoId, storage });
      try {
        await dirty.pool.query(
          `INSERT INTO ha_artifact_documents
             (tenant_id, project_id, policy_epoch, all_readers, reader, readers, path, package_dir, relative, kind, sort_ms, occurred_at, size_bytes)
           VALUES ('t','p',1,true,'','{}','tasks/task-x/artifacts/bogus.html','task-x','artifacts/bogus.html','html',-1,'2026-08-01T00:00:00.000Z',7)`,
        );
        await dirty.pool.query("UPDATE ha_artifact_counts SET total=99 WHERE kind='md'");
      } finally {
        await dirty.close();
      }
      const third = open();
      try {
        assert.equal(third.projection.readArtifactTimelinePage({ kind: "html", limit: 10 }).rows.length, 1);
        third.projection.rebuild();
        const rebuilt = third.projection.readArtifactTimelinePage({ kind: "md", limit: 10 });
        assert.deepEqual(
          rebuilt.rows.map(({ relative }) => relative),
          ["artifacts/parity.md"],
        );
        assert.deepEqual(rebuilt.counts, { html: 0, md: 1, raw: 0 });
        assert.equal(third.projection.readArtifactTimelinePage({ kind: "html", limit: 10 }).rows.length, 0);
      } finally {
        third.projection.close();
        await third.store.drain();
      }
    });
  });
  test("retirement and reclassification keep counts non-negative and exact", async () => {
    const db = await PGlite.create();
    const client = { query: (text: string, values?: unknown[]) => db.query(text, values) };
    try {
      await createTimelineSchema(db);
      const scope = { ...base, readers: ["a"] },
        target = "tasks/pkg-a/artifacts/report.html";
      await projectPgArtifactDocument(client, scope, target, html, "2026-08-01T00:00:00.000Z");
      // Reclassify the same path: the html count must drop and md must rise in one write.
      await projectPgArtifactDocument(client, scope, target, markdown, "2026-08-02T00:00:00.000Z");
      assert.deepEqual((await readPgArtifactTimeline(client, scope, { kind: "html", limit: 10 })).counts, {
        html: 0,
        md: 1,
        raw: 0,
      });
      assert.deepEqual(
        (await readPgArtifactTimeline(client, scope, { kind: "md", limit: 10 })).rows.map(({ relative }) => relative),
        ["artifacts/report.html"],
      );
      // Removing the only row produces a -1 delta; a CHECK-validating INSERT would fail here.
      await flushPgArtifactDocuments(client, scope, [artifactRetirementEntry(target)!]);
      assert.deepEqual((await readPgArtifactTimeline(client, scope, { kind: "md", limit: 10 })).counts, {
        html: 0,
        md: 0,
        raw: 0,
      });
      assert.equal((await readPgArtifactTimeline(client, scope, { kind: "md", limit: 10 })).rows.length, 0);
    } finally {
      await db.close();
    }
  });

  test("sparse readers page by reader index and count only the visible set", async () => {
    const db = await PGlite.create();
    const client = { query: (text: string, values?: unknown[]) => db.query(text, values) };
    try {
      await createTimelineSchema(db);
      for (let index = 0; index < 40; index += 1) {
        const id = String(index).padStart(2, "0");
        await projectPgArtifactDocument(
          client,
          { ...base, readers: [`r${id}`] },
          `tasks/pkg-a/artifacts/doc-${id}.html`,
          html,
          new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
        );
      }
      const sparse = await readPgArtifactTimeline(client, { ...base, readers: ["r07"] }, { kind: "html", limit: 1 });
      assert.deepEqual(
        sparse.rows.map(({ relative }) => relative),
        ["artifacts/doc-07.html"],
      );
      assert.deepEqual(sparse.counts, { html: 1, md: 0, raw: 0 });
      const twoReaders = await readPgArtifactTimeline(
        client,
        { ...base, readers: ["r07", "r08"] },
        { kind: "html", limit: 1 },
      );
      assert.deepEqual(twoReaders.counts, { html: 2, md: 0, raw: 0 });
      const all = await readPgArtifactTimeline(client, { ...base, readers: [] }, { kind: "html", limit: 500 });
      assert.deepEqual(all.counts, { html: 40, md: 0, raw: 0 });
    } finally {
      await db.close();
    }
  });

  test("binary path order survives case/accent cursors without gaps or duplicates", async () => {
    const db = await PGlite.create();
    const client = { query: (text: string, values?: unknown[]) => db.query(text, values) };
    try {
      await createTimelineSchema(db);
      const names = ["Z.html", "a.html", "Ä.html", "ä.html", "A.html", "z.html"],
        occurredAt = "2026-08-01T00:00:00.000Z";
      for (const name of names)
        await projectPgArtifactDocument(
          client,
          { ...base, readers: [] },
          `tasks/pkg-a/artifacts/${name}`,
          html,
          occurredAt,
        );
      const seen: string[] = [];
      let cursor: { occurredAt: string; relative: string; packageDir: string } | undefined;
      for (let page = 0; page < names.length + 1; page += 1) {
        const read = await readPgArtifactTimeline(
          client,
          { ...base, readers: [] },
          {
            kind: "html",
            limit: 2,
            ...(cursor ? { after: cursor } : {}),
          },
        );
        seen.push(...read.rows.map(({ relative }) => relative));
        if (!read.hasMore) break;
        const last = read.rows.at(-1)!;
        cursor = { occurredAt: last.occurredAt, relative: last.relative, packageDir: last.packageDir };
      }
      const expected = names.map((name) => `artifacts/${name}`).sort((left, right) => (left < right ? -1 : 1));
      assert.deepEqual(seen, expected);
      assert.equal(new Set(seen).size, seen.length);
    } finally {
      await db.close();
    }
  });
  test("the internal all-reader row cannot be reached by a literal reader identity", async () => {
    const db = await PGlite.create();
    const client = { query: (text: string, values?: unknown[]) => db.query(text, values) };
    try {
      await createTimelineSchema(db);
      await projectPgArtifactDocument(
        client,
        { ...base, readers: ["*"] },
        "tasks/pkg-a/artifacts/star.html",
        html,
        "2026-08-01T00:00:00.000Z",
      );
      await projectPgArtifactDocument(
        client,
        { ...base, readers: ["a"] },
        "tasks/pkg-a/artifacts/a.html",
        html,
        "2026-08-02T00:00:00.000Z",
      );
      const literalStar = await readPgArtifactTimeline(
        client,
        { ...base, readers: ["*"] },
        { kind: "html", limit: 10 },
      );
      assert.deepEqual(
        literalStar.rows.map(({ relative }) => relative),
        ["artifacts/star.html"],
        "a literal '*' reader must match the document's own reader set, not the internal all-reader row",
      );
      assert.deepEqual(literalStar.counts, { html: 1, md: 0, raw: 0 });
      const all = await readPgArtifactTimeline(client, { ...base, readers: [] }, { kind: "html", limit: 10 });
      assert.deepEqual(
        all.rows.map(({ relative }) => relative),
        ["artifacts/a.html", "artifacts/star.html"],
      );
      assert.deepEqual(all.counts, { html: 2, md: 0, raw: 0 });
    } finally {
      await db.close();
    }
  });
});

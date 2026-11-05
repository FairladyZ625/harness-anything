// harness-test-tier: integration
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensureArtifactTimelineBackfill } from "../../src/projection/artifact-timeline-projection.ts";
import { withTempStoreAsync } from "./helpers.ts";
import { projectionFixture } from "./relation-graph-projection.fixtures.ts";

function addEvent(db: DatabaseSync, revision: number, occurredAt: string): void {
  db.prepare("INSERT INTO event_index(op_id, workspace_revision, task_id, event_json) VALUES (?, ?, NULL, ?)").run(
    `op-${revision}`,
    revision,
    JSON.stringify({ occurredAt }),
  );
}

function addDocument(
  db: DatabaseSync,
  input: {
    readonly revision: number;
    readonly path: string;
    readonly mediaType: string;
    readonly policyId: string;
    readonly size?: number;
  },
): void {
  db.prepare("INSERT INTO document(path, workspace_revision, value_json) VALUES (?, ?, ?)").run(
    input.path,
    input.revision,
    JSON.stringify({
      path: input.path,
      workspaceRevision: input.revision,
      blobSha256: "sha256:fixture",
      size: input.size ?? 7,
      mediaType: input.mediaType,
      policyId: input.policyId,
    }),
  );
}

function addTask(db: DatabaseSync, taskId: string, packageDir: string, title: string): void {
  db.prepare("INSERT INTO task_package(task_id, package_path) VALUES (?, ?)").run(taskId, `tasks/${packageDir}`);
  db.prepare(
    "INSERT INTO task_snapshot(task_id, workspace_revision, snapshot_json, status, updated_at) VALUES (?, 1, ?, 'done', '2026-08-01T00:00:00.000Z')",
  ).run(taskId, JSON.stringify({ task: { title, pinned: false } }));
}

test("the artifact timeline pages by ledger time and package-relative path without reading history", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const { projection } = projectionFixture(rootDir);
    projection.readCut(); // materialize the projection file before the seed connection opens it
    const db = new DatabaseSync(projection.path);
    try {
      db.exec("BEGIN");
      addTask(db, "task_a", "pkg-a", "Package A");
      addEvent(db, 1, "2026-08-01T00:00:00.000Z");
      addDocument(db, {
        revision: 1,
        path: "tasks/pkg-b/artifacts/a.html",
        mediaType: "text/html",
        policyId: "opaque-textual-whole-file/v1",
      });
      addDocument(db, {
        revision: 1,
        path: "tasks/pkg-a/artifacts/z.html",
        mediaType: "text/html",
        policyId: "opaque-textual-whole-file/v1",
      });
      addEvent(db, 2, "2026-07-01T00:00:00.000Z");
      addDocument(db, {
        revision: 2,
        path: "tasks/pkg-a/artifacts/a.html",
        mediaType: "text/html",
        policyId: "opaque-textual-whole-file/v1",
      });
      addDocument(db, {
        revision: 2,
        path: "tasks/pkg-a/artifacts/notes.md",
        mediaType: "text/markdown",
        policyId: "markdown-body-replaceable/v1",
      });
      addDocument(db, {
        revision: 2,
        path: "tasks/pkg-a/artifacts/dossier.pdf",
        mediaType: "application/octet-stream",
        policyId: "raw-artifact-bytes/v1",
        size: 13,
      });
      // Non-timeline documents: package prose and a textual-named file the raw facet excludes.
      addDocument(db, {
        revision: 2,
        path: "tasks/pkg-a/task_plan.md",
        mediaType: "text/markdown",
        policyId: "markdown-body-replaceable/v1",
      });
      addDocument(db, {
        revision: 2,
        path: "tasks/pkg-a/artifacts/data.txt",
        mediaType: "text/plain",
        policyId: "opaque-textual-whole-file/v1",
      });
      db.exec("COMMIT");

      const first = projection.readArtifactTimelinePage({ kind: "html", limit: 2 });
      assert.equal(first.status, "ready");
      assert.deepEqual(
        first.rows.map(({ packageDir, relative }) => `${packageDir}/${relative}`),
        ["pkg-b/artifacts/a.html", "pkg-a/artifacts/z.html"],
        "same-time rows order by relative path then package directory",
      );
      assert.equal(first.hasMore, true);
      assert.deepEqual(first.counts, { html: 3, md: 1, raw: 1 });
      assert.equal(
        first.rows.every(({ occurredAt }) => occurredAt === "2026-08-01T00:00:00.000Z"),
        true,
      );
      const attributed = first.rows.find(({ packageDir }) => packageDir === "pkg-a")!;
      assert.equal(attributed.taskId, "task_a");
      assert.equal(attributed.taskTitle, "Package A");
      assert.equal(attributed.packagePath, "tasks/pkg-a");
      const unattributed = first.rows.find(({ packageDir }) => packageDir === "pkg-b")!;
      assert.equal(unattributed.taskId, null);
      assert.equal(unattributed.packagePath, null);

      // The cursor is the last row's (time, relative, packageDir): the second page excludes it and
      // ends with hasMore=false, so a driver loop terminates on the reader's own signal.
      const last = first.rows.at(-1)!,
        second = projection.readArtifactTimelinePage({
          kind: "html",
          limit: 2,
          after: {
            occurredAt: last.occurredAt,
            relative: last.relative,
            packageDir: last.packageDir,
          },
        });
      assert.deepEqual(
        second.rows.map(({ relative }) => relative),
        ["artifacts/a.html"],
      );
      assert.equal(second.hasMore, false);
      assert.deepEqual(second.counts, first.counts, "counts describe the whole facet, not the page");

      // An overwrite moves the row to its new ledger time without changing the total.
      addEvent(db, 3, "2026-09-01T00:00:00.000Z");
      db.prepare("UPDATE document SET workspace_revision = 3, value_json = ? WHERE path = ?").run(
        JSON.stringify({
          path: "tasks/pkg-a/artifacts/a.html",
          workspaceRevision: 3,
          blobSha256: "sha256:fixture",
          size: 7,
          mediaType: "text/html",
          policyId: "opaque-textual-whole-file/v1",
        }),
        "tasks/pkg-a/artifacts/a.html",
      );
      const moved = projection.readArtifactTimelinePage({ kind: "html", limit: 1 });
      assert.equal(moved.rows[0]!.occurredAt, "2026-09-01T00:00:00.000Z");
      assert.deepEqual(moved.counts, { html: 3, md: 1, raw: 1 });

      // A retirement removes exactly one row and one count.
      db.prepare("DELETE FROM document WHERE path = ?").run("tasks/pkg-a/artifacts/z.html");
      const retired = projection.readArtifactTimelinePage({ kind: "html", limit: 500 });
      assert.deepEqual(retired.counts, { html: 2, md: 1, raw: 1 });
      assert.equal(
        retired.rows.some(({ relative }) => relative === "artifacts/z.html"),
        false,
      );

      const markdown = projection.readArtifactTimelinePage({ kind: "md", limit: 500 });
      assert.deepEqual(
        markdown.rows.map(({ relative }) => relative),
        ["artifacts/notes.md"],
        "textual-named non-Markdown artifacts are not part of the markdown facet",
      );
      assert.equal(markdown.counts.md, 1);
      const raw = projection.readArtifactTimelinePage({ kind: "raw", limit: 500 });
      assert.deepEqual(
        raw.rows.map(({ relative, sizeBytes }) => [relative, sizeBytes]),
        [["artifacts/dossier.pdf", 13]],
      );
      assert.equal(raw.rows[0]!.taskId, "task_a");

      assert.throws(() => projection.readArtifactTimelinePage({ kind: "html", limit: 0 }), /limit/u);
      assert.throws(() => projection.readArtifactTimelinePage({ kind: "html", limit: 501 }), /limit/u);
      assert.throws(
        () =>
          projection.readArtifactTimelinePage({
            kind: "html",
            limit: 1,
            after: { occurredAt: "not-a-time", relative: "artifacts/a.html", packageDir: "pkg-a" },
          }),
        /cursor time/u,
      );
    } finally {
      db.close();
      projection.close();
    }
  });
});

test("a cache written before the artifact index backfills once from projected documents", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const { projection } = projectionFixture(rootDir);
    projection.readCut(); // materialize the projection file before the seed connection opens it
    const db = new DatabaseSync(projection.path);
    try {
      db.exec("BEGIN");
      addEvent(db, 1, "2026-08-01T00:00:00.000Z");
      addDocument(db, {
        revision: 1,
        path: "tasks/pkg-a/artifacts/one.html",
        mediaType: "text/html",
        policyId: "opaque-textual-whole-file/v1",
      });
      addDocument(db, {
        revision: 1,
        path: "tasks/pkg-a/artifacts/two.md",
        mediaType: "text/markdown",
        policyId: "markdown-body-replaceable/v1",
      });
      db.exec("COMMIT");
      // Simulate a legacy cache: the documents exist, the index and its marker do not.
      db.exec(
        "DELETE FROM artifact_document; DELETE FROM artifact_count; DELETE FROM projection_maintenance WHERE key = 'artifact-timeline-v1'",
      );
      ensureArtifactTimelineBackfill(db);
      const page = projection.readArtifactTimelinePage({ kind: "html", limit: 1 });
      assert.deepEqual(
        page.rows.map(({ relative }) => relative),
        ["artifacts/one.html"],
      );
      assert.deepEqual(page.counts, { html: 1, md: 1, raw: 0 });
      // The marker makes a second open a no-op even if a row is added outside the live trigger set.
      db.exec("DELETE FROM artifact_document WHERE path = 'tasks/pkg-a/artifacts/one.html'");
      ensureArtifactTimelineBackfill(db);
      assert.equal(projection.readArtifactTimelinePage({ kind: "html", limit: 1 }).rows.length, 0);
    } finally {
      db.close();
      projection.close();
    }
  });
});

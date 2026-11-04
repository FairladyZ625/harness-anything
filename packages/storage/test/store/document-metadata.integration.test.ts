// harness-test-tier: integration
import assert from "node:assert/strict";
import { applyDecision, projectionFixture, proposal } from "./relation-graph-projection.fixtures.ts";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { withTempStoreAsync } from "./helpers.ts";

test("document lists and revision reads do not fetch or parse inline document bodies", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    const fixture = projectionFixture(rootDir);
    applyDecision(fixture, proposal(1, "dec_METADATA"));
    const { projection } = fixture;
    const db = new DatabaseSync(projection.path),
      path = "tasks/task-large/artifacts/report.md";
    const insert = db.prepare("INSERT OR REPLACE INTO document(path, workspace_revision, value_json) VALUES (?, ?, ?)");
    const bodySizes = [128, 32 * 1024 * 1024];
    const timings: number[] = [];
    try {
      for (const size of bodySizes) {
        insert.run(
          path,
          7,
          JSON.stringify({
            path,
            workspaceRevision: 7,
            body: "x".repeat(size),
            blobSha256: "sha256:fixture",
            size,
            mediaType: "text/markdown",
            policyId: "fixture",
          }),
        );
        insert.run(
          "decisions/decision-dec_METADATA/decision.md",
          7,
          JSON.stringify({
            path: "decisions/decision-dec_METADATA/decision.md",
            workspaceRevision: 7,
            body: "x".repeat(size),
            blobSha256: "sha256:fixture",
            size,
            mediaType: "text/markdown",
            policyId: "fixture",
          }),
        );
        const parse = JSON.parse;
        const guard = t.mock.method(JSON, "parse", (text: string, ...args: unknown[]) => {
          assert.ok(text.length < 1024 * 1024, "metadata read parsed a document body");
          return Reflect.apply(parse, JSON, [text, ...args]);
        });
        const start = performance.now();
        for (let sample = 0; sample < 50; sample++) {
          assert.deepEqual(projection.readDocumentMetadata(path).document, { path, workspaceRevision: 7 });
          assert.equal(projection.readDecisions(["dec_METADATA"], false).decisions[0]?.body, null);
          assert.equal(projection.readDecision("dec_METADATA", false).decision?.body, null);
          const documents = projection.readDocuments("tasks/").documents;
          assert.deepEqual(documents, [
            { path, blobSha256: "sha256:fixture", size, mediaType: "text/markdown", policyId: "fixture" },
          ]);
        }
        timings.push(performance.now() - start);
        guard.mock.restore();
      }
      assert.ok(timings[1]! < Math.max(100, timings[0]! * 5), JSON.stringify({ bodySizes, timings }));
      assert.equal(projection.readDocument(path).document?.body.length, bodySizes[1]);
      assert.equal(projection.readDocumentMetadata("missing").document, null);
      t.diagnostic(`metadata-body-size-comparison=${JSON.stringify({ bodySizes, timings, samples: 50 })}`);
    } finally {
      db.close();
      projection.close();
    }
  });
});

test("SQLite document prefix pages use the path index and terminate after the final page", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    const fixture = projectionFixture(rootDir);
    applyDecision(fixture, proposal(1, "dec_DOCUMENT_PAGES"));
    const { projection } = fixture,
      db = new DatabaseSync(projection.path);
    try {
      const insert = db.prepare("INSERT INTO document(path,workspace_revision,value_json) VALUES(?,1,?)");
      db.exec("BEGIN");
      for (let n = 0; n < 100000; n++) {
        const path = `history/${String(n).padStart(6, "0")}`;
        insert.run(path, JSON.stringify({ path, blobSha256: "digest", size: 1, mediaType: "text/plain" }));
      }
      for (const path of ["target/%_/a", "target/%_/b", "target/%_/深😀", "target/other"])
        insert.run(path, JSON.stringify({ path, blobSha256: "digest", size: 1, mediaType: "text/plain" }));
      db.exec("COMMIT");
      const plans: unknown[] = [],
        prepare = DatabaseSync.prototype.prepare;
      const guard = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
        const statement = Reflect.apply(prepare, this, [sql]);
        if (!sql.includes("FROM document WHERE path")) return statement;
        const explain = (query: string) => Reflect.apply(prepare, this, [query]);
        return new Proxy(statement, {
          get(target, key) {
            if (key === "all")
              return (...values: unknown[]) => {
                const explained = explain(`EXPLAIN QUERY PLAN ${sql}`);
                plans.push(Reflect.apply(explained.all, explained, values));
                return Reflect.apply(target.all, target, values);
              };
            const value: unknown = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      });
      try {
        const first = projection.readDocuments("target/%_/", { limit: 2 });
        assert.deepEqual(
          first.documents.map((row) => row.path),
          ["target/%_/a", "target/%_/b"],
        );
        assert.equal(first.page!.nextPath, "target/%_/b");
        const last = projection.readDocuments("target/%_/", { limit: 2, afterPath: first.page!.nextPath! });
        assert.deepEqual(
          last.documents.map((row) => row.path),
          ["target/%_/深😀"],
        );
        assert.equal(last.page!.nextPath, null);
        assert.deepEqual(
          projection.readDocuments("target/%_/", { limit: 2, afterPath: "target/%_/深😀" }).documents,
          [],
        );
        assert.ok(plans.length >= 2);
        for (const rows of plans as { detail: string }[][])
          for (const row of rows)
            assert.match(row.detail, /SEARCH document USING (?:COVERING )?INDEX .*\(path>\? AND path<\?\)/u);
        t.diagnostic(`SQLITE_DOCUMENT_INDEX ${JSON.stringify(plans)}`);
      } finally {
        guard.mock.restore();
      }
    } finally {
      db.close();
      projection.close();
    }
  });
});

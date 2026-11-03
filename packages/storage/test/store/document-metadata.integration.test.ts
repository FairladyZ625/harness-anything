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

// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeMarkdownArtifactStore } from "../../src/index.ts";

test("markdown artifact store recursively lists authored Markdown paths only", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-authored-docs-"));
  try {
    writeDocument(rootDir, "harness/adr/ADR-0001.md", "# ADR\n");
    writeDocument(rootDir, "harness/decisions/decision-dec_test/decision.md", "# Decision\n");
    writeDocument(rootDir, "harness/artifacts/.gitkeep", "");
    writeDocument(rootDir, "harness/artifacts/diagram.png", "not a document");

    const store = makeMarkdownArtifactStore({ rootDir });
    assert.deepEqual(Effect.runSync(store.listAuthoredDocuments()), [
      { path: "adr/ADR-0001.md" },
      { path: "decisions/decision-dec_test/decision.md" }
    ]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("markdown artifact store classifies task package documents and attachments", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-task-artifacts-"));
  try {
    writeDocument(rootDir, "harness/tasks/task-1/notes.md", "# Notes\n");
    writeDocument(rootDir, "harness/tasks/task-1/diagram.png", "not really a png");

    const taskPackage = Effect.runSync(makeMarkdownArtifactStore({ rootDir }).readTaskPackage("task-1"));
    assert.deepEqual(taskPackage.documents.map(({ path: documentPath, kind }) => ({ path: documentPath, kind })), [
      { path: "diagram.png", kind: "attachment" },
      { path: "notes.md", kind: "document" }
    ]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function writeDocument(rootDir: string, documentPath: string, body: string): void {
  const target = path.join(rootDir, documentPath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
}

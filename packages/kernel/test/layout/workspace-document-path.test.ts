// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { documentWorkspacePath, resolveWorkspaceDocumentPath } from "@harness-anything/kernel";

function fixture(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(path.join(tmpdir(), "ha-workspace-doc-path-"));
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "harness", "harness.yaml"), "schema: harness-settings/v1\n");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("a document path is workspace-relative and translates to the authored key", (t) => {
  const root = fixture(t);
  assert.deepEqual(resolveWorkspaceDocumentPath(root, "harness/tasks/task_a/x.md"), {
    ok: true,
    documentPath: "tasks/task_a/x.md",
  });
  assert.deepEqual(resolveWorkspaceDocumentPath(root, "harness/context/../context/a.md"), {
    ok: true,
    documentPath: "context/a.md",
  });
  assert.deepEqual(resolveWorkspaceDocumentPath(root, path.join(root, "harness", "tasks", "a.md")), {
    ok: true,
    documentPath: "tasks/a.md",
  });
});

test("the ledger-repository spelling is the same key as the workspace-repository spelling", (t) => {
  const root = fixture(t);
  assert.deepEqual(resolveWorkspaceDocumentPath(root, "tasks/task_a/x.md"), {
    ok: true,
    documentPath: "tasks/task_a/x.md",
  });
});

test("from the authored root itself the repository-relative spelling is the authored key", (t) => {
  const ledgerRoot = path.join(fixture(t), "harness");
  assert.deepEqual(resolveWorkspaceDocumentPath(ledgerRoot, "tasks/task_a/x.md"), {
    ok: true,
    documentPath: "tasks/task_a/x.md",
  });
});

test("the output inverse round-trips the input spelling from the same workspace root", (t) => {
  const root = fixture(t);
  assert.equal(documentWorkspacePath(root, "tasks/task_a/x.md"), "harness/tasks/task_a/x.md");
  const ledgerRoot = path.join(root, "harness");
  assert.equal(documentWorkspacePath(ledgerRoot, "tasks/task_a/x.md"), "tasks/task_a/x.md");
  const resolved = resolveWorkspaceDocumentPath(root, documentWorkspacePath(root, "tasks/task_a/x.md"));
  assert.deepEqual(resolved, { ok: true, documentPath: "tasks/task_a/x.md" });
});

test("paths that escape every repository root are refused", (t) => {
  const root = fixture(t);
  assert.equal(resolveWorkspaceDocumentPath(root, "../escape.md").ok, false);
  assert.equal(resolveWorkspaceDocumentPath(root, "tasks/../../escape.md").ok, false);
  assert.equal(resolveWorkspaceDocumentPath(root, "/etc/hosts").ok, false);
});

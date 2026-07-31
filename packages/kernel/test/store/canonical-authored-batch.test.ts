// harness-test-tier: fast
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256Text, type WriteOp } from "../../src/index.ts";
import {
  applyCanonicalAuthoredBatch,
  canonicalAuthoredBatchWrites,
  validateCanonicalAuthoredBatch
} from "../../src/write-coordination/journal/operations/canonical-authored-batch.ts";

const reservedPaths = [
  "tasks/task_01KX3W4V1EDPHPTGWYYBQQ2J75/INDEX.md",
  "tasks/task_01KX3W4V1EDPHPTGWYYBQQ2J75/task-contract.json",
  "tasks/task_01KX3W4V1EDPHPTGWYYBQQ2J75/executions/fake.md",
  "tasks/task_01KX3W4V1EDPHPTGWYYBQQ2J75/reviews/fake.md"
] as const;

for (const kind of ["doc_sync_submit", "script_ingest"] as const) {
  test(`${kind} cannot write Task typed-authority paths`, () => {
    for (const path of reservedPaths) {
      assert.throws(() => canonicalAuthoredBatchWrites(batch(kind, path)), /typed-authority path/u);
    }
  });
}

test("script_ingest retains its declared Task artifact surface", () => {
  assert.deepEqual(canonicalAuthoredBatchWrites(batch(
    "script_ingest",
    "tasks/task_01KX3W4V1EDPHPTGWYYBQQ2J75/artifacts/report.json"
  )), [{
    path: "tasks/task_01KX3W4V1EDPHPTGWYYBQQ2J75/artifacts/report.json",
    body: "{}\n",
    baseBlobSha256: null
  }]);
});

test("doc_sync_submit apply rejects a deleted working-tree body reference", () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "ha-doc-sync-working-tree-"));
  const relativePath = "tasks/task_A/artifacts/large.raw.jsonl";
  const absolutePath = path.join(rootDir, "harness", relativePath);
  const body = "large evidence\n";
  try {
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, body, "utf8");
    const op = workingTreeBatch(relativePath, body, null);

    rmSync(absolutePath);
    assert.doesNotThrow(() => validateCanonicalAuthoredBatch(rootDir, op));
    assert.throws(() => applyCanonicalAuthoredBatch(rootDir, op), /working-tree body reference/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doc_sync_submit apply rejects a working-tree body rolled back to its base", () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "ha-doc-sync-working-tree-"));
  const relativePath = "tasks/task_A/artifacts/large.raw.jsonl";
  const absolutePath = path.join(rootDir, "harness", relativePath);
  const baseBody = "base evidence\n";
  const submittedBody = "submitted evidence\n";
  try {
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, submittedBody, "utf8");
    const op = workingTreeBatch(relativePath, submittedBody, sha256Text(baseBody));

    writeFileSync(absolutePath, baseBody, "utf8");
    assert.doesNotThrow(() => validateCanonicalAuthoredBatch(rootDir, op));
    assert.throws(() => applyCanonicalAuthoredBatch(rootDir, op), /working-tree body reference/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doc_sync_submit apply rejects working-tree drift after validation", () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "ha-doc-sync-working-tree-"));
  const relativePath = "tasks/task_A/artifacts/large.raw.jsonl";
  const absolutePath = path.join(rootDir, "harness", relativePath);
  const body = "large evidence\n";
  try {
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, body, "utf8");
    const op = workingTreeBatch(relativePath, body, null);

    assert.doesNotThrow(() => validateCanonicalAuthoredBatch(rootDir, op));
    writeFileSync(absolutePath, "changed after validation\n", "utf8");
    assert.throws(() => applyCanonicalAuthoredBatch(rootDir, op), /working-tree body reference/u);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("doc_sync_submit apply rejects a symlink working-tree body reference", () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "ha-doc-sync-working-tree-"));
  const relativePath = "tasks/task_A/artifacts/large.raw.jsonl";
  const absolutePath = path.join(rootDir, "harness", relativePath);
  const symlinkTarget = path.join(rootDir, "outside.raw.jsonl");
  const body = "large evidence\n";
  try {
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(symlinkTarget, body, "utf8");
    symlinkSync(symlinkTarget, absolutePath);
    const op = workingTreeBatch(relativePath, body, null);

    assert.doesNotThrow(() => validateCanonicalAuthoredBatch(rootDir, op));
    assert.throws(() => applyCanonicalAuthoredBatch(rootDir, op), /regular file/u);
    assert.equal(lstatSync(absolutePath).isSymbolicLink(), true);
    assert.equal(readFileSync(symlinkTarget, "utf8"), body);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("mixed batch rollback restores only inline paths that apply could write", () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "ha-doc-sync-working-tree-"));
  const authoredRoot = path.join(rootDir, "harness");
  const referencedPath = path.join(authoredRoot, "artifacts/referenced.jsonl");
  const changedPath = path.join(authoredRoot, "notes/changed.md");
  const blockingParent = path.join(authoredRoot, "blocked");
  const referencedBody = "referenced evidence\n";
  const originalChangedBody = "original note\n";
  try {
    mkdirSync(path.dirname(referencedPath), { recursive: true });
    mkdirSync(path.dirname(changedPath), { recursive: true });
    writeFileSync(referencedPath, referencedBody, "utf8");
    writeFileSync(changedPath, originalChangedBody, "utf8");
    writeFileSync(blockingParent, "not a directory\n", "utf8");
    const referencedInode = statSync(referencedPath).ino;
    const op: WriteOp = {
      opId: "op-doc-sync-mixed-rollback",
      entityId: "entity/test/doc-sync-mixed-rollback",
      kind: "doc_sync_submit",
      payload: {
        writes: [
          {
            path: "artifacts/referenced.jsonl",
            bodySha256: sha256Text(referencedBody),
            baseBlobSha256: null
          },
          {
            path: "notes/changed.md",
            body: "changed note\n",
            baseBlobSha256: sha256Text(originalChangedBody)
          },
          {
            path: "blocked/failure.md",
            body: "cannot land\n",
            baseBlobSha256: null
          }
        ]
      }
    };

    assert.throws(() => applyCanonicalAuthoredBatch(rootDir, op));
    assert.equal(readFileSync(referencedPath, "utf8"), referencedBody);
    assert.equal(statSync(referencedPath).ino, referencedInode);
    assert.equal(readFileSync(changedPath, "utf8"), originalChangedBody);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("canonical authored working-tree references require a sha256 digest", () => {
  assert.throws(() => canonicalAuthoredBatchWrites({
    opId: "op-invalid-working-tree-digest",
    entityId: "entity/test/invalid-working-tree-digest",
    kind: "doc_sync_submit",
    payload: {
      writes: [{
        path: "tasks/task_A/artifacts/large.raw.jsonl",
        bodySha256: "not-a-sha256",
        baseBlobSha256: null
      }]
    }
  }), /exactly one of body\/bodySha256/u);
});

function batch(kind: "doc_sync_submit" | "script_ingest", path: string): WriteOp {
  return {
    opId: `op-${kind}`,
    entityId: "entity/test/canonical-batch",
    kind,
    payload: { writes: [{ path, body: "{}\n", baseBlobSha256: null }] }
  };
}

function workingTreeBatch(
  relativePath: string,
  body: string,
  baseBlobSha256: string | null
): WriteOp {
  return {
    opId: "op-doc-sync-working-tree",
    entityId: "entity/test/doc-sync-working-tree",
    kind: "doc_sync_submit",
    payload: {
      writes: [{
        path: relativePath,
        bodySha256: sha256Text(body),
        baseBlobSha256
      }]
    }
  };
}

// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("doc_sync_submit references an exact pre-applied working-tree body and rejects drift", () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "ha-doc-sync-working-tree-"));
  const relativePath = "tasks/task_A/artifacts/large.raw.jsonl";
  const absolutePath = path.join(rootDir, "harness", relativePath);
  const body = "large evidence\n";
  try {
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, body, "utf8");
    const op: WriteOp = {
      opId: "op-doc-sync-working-tree",
      entityId: "entity/test/doc-sync-working-tree",
      kind: "doc_sync_submit",
      payload: {
        writes: [{
          path: relativePath,
          bodySha256: sha256Text(body),
          baseBlobSha256: null
        }]
      }
    };

    assert.doesNotThrow(() => validateCanonicalAuthoredBatch(rootDir, op));
    applyCanonicalAuthoredBatch(rootDir, op);
    assert.equal(readFileSync(absolutePath, "utf8"), body);

    writeFileSync(absolutePath, "changed after validation\n", "utf8");
    assert.throws(
      () => validateCanonicalAuthoredBatch(rootDir, op),
      /canonical authored base changed before doc_sync_submit/u
    );
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

// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { WriteOp } from "../../src/index.ts";
import { canonicalAuthoredBatchWrites } from "../../src/store/canonical-authored-batch.ts";

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

function batch(kind: "doc_sync_submit" | "script_ingest", path: string): WriteOp {
  return {
    opId: `op-${kind}`,
    entityId: "entity/test/canonical-batch",
    kind,
    payload: { writes: [{ path, body: "{}\n", baseBlobSha256: null }] }
  };
}

// harness-test-tier: fast
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "port-physical-io-boundary-known-debt.mjs");
const source = readFileSync(sourcePath, "utf8");

test("physical IO debt citations accept only exact real task ids", async () => {
  await importSource(source.replace("task_01KWXKR6YSV4J4E0H5FGPHKZYN", "task_f7cc215a54a194898ad733c20a"));
  for (const invalidRef of ["task_P4_INT", "task_2301", "task_0123456789abcdef012345678"]) {
    await assert.rejects(
      importSource(source.replace("task_01KWXKR6YSV4J4E0H5FGPHKZYN", invalidRef)),
      /must cite a decision id or task id/u,
    );
  }
});

function importSource(value) {
  return import(`data:text/javascript,${encodeURIComponent(value)}`);
}

// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { checkTaskActionProtocolProjection } from "./generate-task-action-protocol.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("Task Action transport has one current build-time projection", async () => {
  const sources = sourceFiles(path.join(root, "packages")).filter(
    (file) => file.includes(`${path.sep}src${path.sep}`) && !file.endsWith(".d.ts"),
  );
  await assert.doesNotReject(() => checkTaskActionProtocolProjection());
  assert.deepEqual(
    sources.filter((file) => readFileSync(file, "utf8").includes("// task-action-projection:generated:start")),
    [path.join(root, "packages/daemon/src/protocol/daemon-protocol-commands-task.ts")],
  );
  assert.deepEqual(
    sources.filter((file) => readFileSync(file, "utf8").includes("// task-action-json-fields:generated:start")),
    [],
  );
});

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(target);
      return entry.isFile() && entry.name.endsWith(".ts") ? [target] : [];
    })
    .sort();
}

// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readRuntimeBatchFile } from "../src/cli-runtime-batch-input.ts";
import type { ThinCommand } from "../src/cli/thin-command.ts";

function command(rootDir: string, batchFile?: string): ThinCommand {
  return {
    rootDir,
    json: false,
    method: "repo.agentRuntime.batch",
    action: { kind: "runtime-batch", ...(batchFile === undefined ? {} : { batchFile }) },
  } as unknown as ThinCommand;
}

function fixture(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-batch-input-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("a repository-relative batch file is read", (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, "batch.json"), '{"schema":"runtime-batch/v1","entries":[]}\n');
  assert.match(readRuntimeBatchFile(command(root, "batch.json")), /runtime-batch\/v1/u);
});

test("a batch file outside the selected root is refused", (t) => {
  const root = fixture(t);
  assert.throws(
    () => readRuntimeBatchFile(command(root, "../outside.json")),
    (error: Error & { code?: string }) =>
      error.code === "invalid_field" && /stay within the selected repository/u.test(error.message),
  );
  assert.throws(
    () => readRuntimeBatchFile(command(root, path.join(tmpdir(), "outside.json"))),
    (error: Error & { code?: string }) => error.code === "invalid_field",
  );
});

test("a missing batch file argument is a missing field, not a host-path read", (t) => {
  const root = fixture(t);
  assert.throws(
    () => readRuntimeBatchFile(command(root)),
    (error: Error & { code?: string }) => error.code === "missing_field",
  );
});

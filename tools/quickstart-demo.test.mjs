import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const demoScript = path.join(repoRoot, "scripts/quickstart-demo.mjs");
const cliEntry = path.join(repoRoot, "packages/cli/src/index.ts");

test("quickstart demo runs init to task to fact to graph with the source CLI", () => {
  withTempRoot((rootDir) => {
    const stdout = execFileSync(process.execPath, [demoScript, "--cli", cliEntry, "--root", rootDir], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    });
    const result = JSON.parse(stdout);

    assert.equal(result.ok, true);
    assert.equal(result.schema, "quickstart-demo/v1");
    assert.match(result.taskId, /^task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u);
    assert.match(result.factRef, /^fact\/task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}\/F-ABCDEF12$/u);
    assert.equal(result.graphPath.endsWith(".harness/generated/graph-panorama/quickstart.html"), true);
  });
});

test("quickstart demo fails closed when a middle step is deliberately broken", () => {
  withTempRoot((rootDir) => {
    const result = spawnSync(process.execPath, [demoScript, "--cli", cliEntry, "--root", rootDir, "--break-step", "fact-record"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024
    });

    assert.notEqual(result.status, 0);
    const failure = parseLastJsonObject(result.stderr);
    assert.equal(failure.ok, false);
    assert.equal(failure.step, "fact record");
    assert.match(failure.error, /fact record .*exited non-zero/u);
  });
});

function withTempRoot(fn) {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-quickstart-test-"));
  try {
    fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function parseLastJsonObject(output) {
  const start = output.lastIndexOf("{\n");
  assert.notEqual(start, -1, output);
  return JSON.parse(output.slice(start));
}

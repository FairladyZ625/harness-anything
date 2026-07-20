// harness-test-tier: integration
import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkerPath = path.join(repoRoot, "tools/check-implementation-contracts.mjs");

test("implementation contract check rejects direct ArtifactStoreWriter calls from public write helpers", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-implementation-contract-"));
  try {
    for (const relativePath of ["package.json", "package-lock.json", "tsconfig.json", "packages"]) {
      cpSync(path.join(repoRoot, relativePath), path.join(root, relativePath), {
        recursive: true,
        filter: (source) => !/(?:^|\/)(?:node_modules|dist|out)(?:\/|$)/.test(source)
      });
    }

    const baseline = runChecker(root);
    assert.equal(baseline.status, 0, baseline.stderr);

    appendFileSync(
      path.join(root, "packages/kernel/src/write-coordination/write-helpers.ts"),
      "\nexport function implementationContractPositiveControl(writer) { return writer.writeDocument('task.md', 'body'); }\n",
      "utf8"
    );

    const injected = runChecker(root);
    t.diagnostic(`write-helpers direct-writer positive control exit=${injected.status}`);
    assert.notEqual(injected.status, 0);
    assert.match(injected.stderr, /write-coordination\/write-helpers\.ts: authored writes must go through WriteCoordinator\.enqueue/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runChecker(cwd) {
  return spawnSync(process.execPath, [checkerPath], {
    cwd,
    encoding: "utf8"
  });
}

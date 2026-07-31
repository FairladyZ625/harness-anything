// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { initializeHarness } from "../src/commands/init.ts";

test("init bounds an unresponsive outer Git process and reports fail-safe degradation", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-init-git-timeout-"));
  const fakeGit = path.join(rootDir, "fake-git.mjs");
  writeFileSync(fakeGit, [
    "const args = process.argv.slice(2);",
    "if (args.includes('rev-parse')) process.exit(1);",
    "if (args.includes('--initial-branch=main')) setInterval(() => undefined, 1_000);",
    "process.exit(1);"
  ].join("\n"), "utf8");

  try {
    const startedAt = performance.now();
    const result = initializeHarness(
      { rootDir },
      false,
      "Git Timeout",
      { name: "Harness Test", email: "harness@example.test" },
      {
        executable: process.execPath,
        prefixArgs: [fakeGit],
        timeoutMs: 100,
        killSignal: "SIGKILL"
      }
    );

    assert.equal(performance.now() - startedAt < 2_000, true);
    assert.equal(result.report.isolation.outerGit.action, "failed");
    assert.equal(result.report.isolation.outerGit.initialCommitCreated, false);
    assert.equal(
      result.warnings.some((warning: Record<string, unknown>) => warning.code === "outer_git_init_failed"),
      true
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

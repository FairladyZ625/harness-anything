// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { localGitWorktreeSettlement } from "../../src/store/local-version-control-system.ts";
import { withTempStore } from "./helpers.ts";

function git(repoRoot: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
}

function ledger(rootDir: string): string {
  const repoRoot = path.join(rootDir, "ledger");
  mkdirSync(repoRoot, { recursive: true });
  git(repoRoot, "init", "--quiet");
  return repoRoot;
}

/** Plants a leftover settlement marker exactly where a killed writer would have left it. */
function plant(directory: string, name: string): string {
  mkdirSync(directory, { recursive: true });
  const marker = path.join(directory, name);
  writeFileSync(marker, "leaked", "utf8");
  return marker;
}

/** A pid that belonged to a process which has provably exited. */
function deadPid(): number {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { pid } = spawnSync(process.execPath, ["-e", "0"], { stdio: "ignore" });
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("could not obtain a pid whose process has exited");
}

test("visible reclaims dead markers of both families in the directory it writes", () => {
  withTempStore((rootDir) => {
    const repoRoot = ledger(rootDir),
      directory = path.join(repoRoot, "tasks", "t1"),
      pid = deadPid(),
      settleMarker = plant(directory, `.ha-settle-${pid}-0`),
      visibleMarker = plant(directory, `.ha-visible-${pid}-3`);

    localGitWorktreeSettlement.visible(repoRoot, [{ target: "tasks/t1/INDEX.md", body: "# t1\n" }]);

    assert.equal(existsSync(settleMarker), false);
    assert.equal(existsSync(visibleMarker), false);
    assert.equal(readFileSync(path.join(directory, "INDEX.md"), "utf8"), "# t1\n");
  });
});

// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
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

test("a rejected owner cannot replace, delete, create directories or regress the index", () => {
  withTempStore((rootDir) => {
    const repoRoot = ledger(rootDir),
      target = path.join(repoRoot, "state.md"),
      stale = new Error("stale owner");
    writeFileSync(target, "successor");
    git(repoRoot, "add", "state.md");
    const before = readFileSync(path.join(repoRoot, ".git/index")),
      withFence = () => {
        throw stale;
      },
      operations = [
        () => localGitWorktreeSettlement.visible(repoRoot, [{ target: "state.md", body: "old" }], { withFence }),
        () => localGitWorktreeSettlement.deleteVisible(repoRoot, ["state.md"], { withFence }),
        () => localGitWorktreeSettlement.visible(repoRoot, [{ directory: "old-directory" }], { withFence }),
        () => localGitWorktreeSettlement.retireEmptyDirectories(repoRoot, ["empty"], withFence),
        () => localGitWorktreeSettlement.index(repoRoot, [{ target: "state.md", body: "old" }], false, withFence),
      ];
    mkdirSync(path.join(repoRoot, "empty"));
    for (const operation of operations) assert.throws(operation, (error) => error === stale);
    assert.equal(readFileSync(target, "utf8"), "successor");
    assert.deepEqual(readFileSync(path.join(repoRoot, ".git/index")), before);
    assert.equal(existsSync(path.join(repoRoot, "empty")), true);
    assert.equal(existsSync(path.join(repoRoot, "old-directory")), false);
    assert.deepEqual(
      readdirSync(repoRoot).filter((name) => name.startsWith(".ha-visible-")),
      [],
    );
  });
});

// A plain `git status` opportunistically writes the refreshed index, so this fingerprint read
// overlapping the settlement worker's update-index could overwrite the freshly settled index with
// the older snapshot it read (F-B9DAA193). The read must never rewrite the index.
test("changesFingerprint reads the worktree without rewriting the Git index", () => {
  withTempStore((rootDir) => {
    const repoRoot = ledger(rootDir);
    writeFileSync(path.join(repoRoot, "tracked.md"), "body\n");
    git(repoRoot, "add", "tracked.md");
    git(repoRoot, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--quiet", "--message=base");
    // Stat-stale the tracked file so an index-writing status has a refresh worth persisting.
    const stale = new Date(Date.now() - 60_000);
    utimesSync(path.join(repoRoot, "tracked.md"), stale, stale);
    const index = path.join(repoRoot, ".git", "index"),
      before = statSync(index),
      fingerprint = localGitWorktreeSettlement.changesFingerprint(repoRoot, "."),
      after = statSync(index);
    assert.equal(fingerprint, null);
    assert.equal(
      `${after.ino}:${after.mtimeMs}`,
      `${before.ino}:${before.mtimeMs}`,
      "the fingerprint read must leave the Git index file untouched",
    );
  });
});

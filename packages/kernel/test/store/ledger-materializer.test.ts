import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeJournaledWriteCoordinator, runLedgerMaterializer } from "../../src/store/index.ts";
import { docWrite, withTempStore } from "./helpers.ts";

test("WriteCoordinator commits session-routed writes to a session branch", () => {
  withTempStore((rootDir) => {
    initAuthoredGit(rootDir);
    const coordinator = makeJournaledWriteCoordinator({
      rootDir,
      sessionId: "codex-session-1",
      autoMaterialize: false
    });

    Effect.runSync(coordinator.enqueue(docWrite("op-session-branch", "task-1", "note.md", "session branch write\n")));
    const report = Effect.runSync(coordinator.flush("explicit"));

    assert.equal(report.opCount, 1);
    assert.equal(git(rootDir, "rev-parse", "--abbrev-ref", "HEAD"), "master");
    assert.equal(git(rootDir, "branch", "--list", "sessions/codex-session-1").trim(), "sessions/codex-session-1");
    assert.match(git(rootDir, "log", "master..sessions/codex-session-1", "--oneline"), /op-session-branch/u);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-1/note.md")), false);
  });
});

test("ledger materializer dry-runs and merges pending session branches", () => {
  withTempStore((rootDir) => {
    initAuthoredGit(rootDir);
    const coordinator = makeJournaledWriteCoordinator({
      rootDir,
      sessionId: "codex-session-2",
      autoMaterialize: false
    });

    Effect.runSync(coordinator.enqueue(docWrite("op-materialize", "task-2", "note.md", "materialized write\n")));
    Effect.runSync(coordinator.flush("explicit"));

    const dryRun = runLedgerMaterializer(rootDir, { dryRun: true });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.merged, 0);
    assert.equal(dryRun.branches.find((branch) => branch.branch === "sessions/codex-session-2")?.status, "would_merge");
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-2/note.md")), false);

    const merged = runLedgerMaterializer(rootDir);
    assert.equal(merged.merged, 1);
    assert.equal(merged.projectionRebuilt, true);
    assert.equal(git(rootDir, "branch", "--list", "sessions/codex-session-2"), "");
    assert.equal(git(rootDir, "rev-parse", "--abbrev-ref", "HEAD"), "master");
    assert.equal(readGitFile(rootDir, "tasks/task-2/note.md"), "materialized write\n");
  });
});

function initAuthoredGit(rootDir: string): void {
  const harnessRoot = path.join(rootDir, "harness");
  mkdirSync(harnessRoot, { recursive: true });
  execFileSync("git", ["-C", harnessRoot, "init", "-b", "master"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "config", "user.name", "Harness Test"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "config", "user.email", "harness@example.test"], { stdio: "ignore" });
  writeFileSync(path.join(harnessRoot, ".gitkeep"), "", "utf8");
  execFileSync("git", ["-C", harnessRoot, "add", "--", ".gitkeep"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "commit", "-m", "seed"], { stdio: "ignore" });
}

function git(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", path.join(rootDir, "harness"), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function readGitFile(rootDir: string, relativePath: string): string {
  return execFileSync("git", ["-C", path.join(rootDir, "harness"), "show", `master:${relativePath}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

// harness-test-tier: integration
import { testWriteAttribution } from "../test-attribution.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeJournaledWriteCoordinator, runLedgerMaterializer } from "../../src/store/index.ts";
import { readAttributionProjection } from "../../src/projection/sqlite-attribution-projection.ts";
import { docWrite, withTempStore } from "./helpers.ts";

test("WriteCoordinator commits session-routed writes to a session branch", () => {
  withTempStore((rootDir) => {
    initAuthoredGit(rootDir);
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(),
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
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(),
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
    assert.equal(merged.attributionEventsProjected, 1);
    assert.equal(readAttributionProjection(rootDir)[0]?.opId, "op-materialize");
  });
});

test("session write + materializer resolve the trunk on a main-trunk repo", () => {
  withTempStore((rootDir) => {
    initAuthoredGit(rootDir, "main");
    const coordinator = makeJournaledWriteCoordinator({ attribution: testWriteAttribution(),
      rootDir,
      sessionId: "codex-session-3",
      autoMaterialize: false
    });

    Effect.runSync(coordinator.enqueue(docWrite("op-main-trunk", "task-3", "note.md", "main trunk write\n")));
    const report = Effect.runSync(coordinator.flush("explicit"));

    // Before the fix this flush threw JournalUnavailable ("pathspec 'master' did not match")
    // even though the entity file had already been written to disk.
    assert.equal(report.opCount, 1);
    assert.equal(git(rootDir, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    assert.match(git(rootDir, "log", "main..sessions/codex-session-3", "--oneline"), /op-main-trunk/u);

    const merged = runLedgerMaterializer(rootDir);
    assert.equal(merged.merged, 1);
    assert.equal(git(rootDir, "branch", "--list", "sessions/codex-session-3"), "");
    assert.equal(git(rootDir, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    assert.equal(readGitFile(rootDir, "tasks/task-3/note.md", "main"), "main trunk write\n");
  });
});

test("a conflicted session branch does not starve a later mergeable branch in a bounded batch", () => {
  withTempStore((rootDir) => {
    initAuthoredGit(rootDir);
    const harnessRoot = path.join(rootDir, "harness");
    writeFileSync(path.join(harnessRoot, "shared.txt"), "base\n", "utf8");
    git(rootDir, "add", "shared.txt");
    git(rootDir, "commit", "-m", "add shared file");

    git(rootDir, "checkout", "-b", "sessions/conflicted-old");
    writeFileSync(path.join(harnessRoot, "shared.txt"), "session value\n", "utf8");
    git(rootDir, "add", "shared.txt");
    git(rootDir, "commit", "-m", "conflicting session write");
    git(rootDir, "checkout", "master");
    writeFileSync(path.join(harnessRoot, "shared.txt"), "trunk value\n", "utf8");
    git(rootDir, "add", "shared.txt");
    git(rootDir, "commit", "-m", "conflicting trunk write");

    const coordinator = makeJournaledWriteCoordinator({
      attribution: testWriteAttribution(),
      rootDir,
      sessionId: "mergeable-later",
      autoMaterialize: false
    });
    Effect.runSync(coordinator.enqueue(docWrite("op-after-conflict", "task-after-conflict", "note.md", "visible\n")));
    Effect.runSync(coordinator.flush("explicit"));

    const report = runLedgerMaterializer(rootDir, { maxBranches: 1 });

    assert.equal(report.branches.find((branch) => branch.branch === "sessions/conflicted-old")?.status, "conflict");
    assert.equal(report.branches.find((branch) => branch.branch === "sessions/mergeable-later")?.status, "merged");
    assert.equal(report.merged, 1);
    assert.equal(readGitFile(rootDir, "tasks/task-after-conflict/note.md"), "visible\n");
  });
});

function initAuthoredGit(rootDir: string, trunk = "master"): void {
  const harnessRoot = path.join(rootDir, "harness");
  mkdirSync(harnessRoot, { recursive: true });
  execFileSync("git", ["-C", harnessRoot, "init", "-b", trunk], { stdio: "ignore" });
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

function readGitFile(rootDir: string, relativePath: string, trunk = "master"): string {
  return execFileSync("git", ["-C", path.join(rootDir, "harness"), "show", `${trunk}:${relativePath}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

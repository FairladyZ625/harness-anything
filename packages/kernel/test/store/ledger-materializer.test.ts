// harness-test-tier: integration
import { testWriteAttribution } from "../test-attribution.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { Effect } from "effect";
import { makeJournaledWriteCoordinator, runLedgerMaterializer } from "../../src/index.ts";
import { authorityBatchTrailerName, buildAuthorityBatchIntegrity } from "../../src/integrity/authority-batch-integrity.ts";
import { localProjectionSourceFileSystem } from "../../src/local/local-layout-file-system.ts";
import { makeLocalVersionControlSystem } from "../../src/persistence/git/local-version-control-system.ts";
import {
  captureAuthoredProjectionFingerprint,
  captureTrustedAuthoredProjectionFingerprint,
  invalidateTrustedAuthoredProjectionFingerprint,
  rememberTrustedAuthoredProjectionFingerprint
} from "../../src/projection/projection-source-baseline.ts";
import { readAttributionProjection } from "../../src/projection/sqlite-attribution-projection.ts";
import { rebuildTaskProjection } from "../../src/projection/sqlite-task-projection.ts";
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
    assert.equal(
      git(rootDir, "show", "-s", "--format=%an <%ae>", "HEAD"),
      "Harness Anything Materializer <materializer@harness-anything.local>"
    );
  });
});

test("trusted generation fingerprint reuses clean state and fails closed on dirty authored state", () => {
  withTempStore((rootDir) => {
    initAuthoredGit(rootDir);
    const taskRoot = path.join(rootDir, "harness/tasks/task-baseline");
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), [
      "---",
      "schema: task-package/v2",
      "task_id: task-baseline",
      "title: Baseline",
      "lifecycle:",
      "  bindingSchema: lifecycle-binding/v1",
      "  engine: local",
      "  status: active",
      "  ref: ",
      "  titleSnapshot: Baseline",
      "  url: ",
      "  bindingCreatedAt: 2026-07-07T00:00:00.000Z",
      "  bindingFingerprint: sha256:fixture",
      "packageDisposition: active",
      "---",
      ""
    ].join("\n"), "utf8");
    git(rootDir, "add", "--", "tasks/task-baseline/INDEX.md");
    git(rootDir, "commit", "-m", "seed fingerprint baseline");

    const vcs = makeLocalVersionControlSystem();
    const first = captureTrustedAuthoredProjectionFingerprint(rootDir, vcs);
    assert.equal(git(rootDir, "status", "--porcelain"), "");
    assert.equal(vcs.workingTreeFiles(vcs.topLevel(path.join(rootDir, "harness"))!, []), "");
    const originalStatSignature = localProjectionSourceFileSystem.statSignature;
    let cleanReuseStats = 0;
    localProjectionSourceFileSystem.statSignature = (inputPath) => {
      cleanReuseStats += 1;
      return originalStatSignature(inputPath);
    };
    try {
      assert.equal(captureTrustedAuthoredProjectionFingerprint(rootDir, vcs), first);
    } finally {
      localProjectionSourceFileSystem.statSignature = originalStatSignature;
    }
    assert.equal(cleanReuseStats, 0);

    let generationStatusCalls = 0;
    const generationVcs = {
      ...vcs,
      workingTreeFiles: (repo: string, paths: ReadonlyArray<string>) => {
        generationStatusCalls += 1;
        return vcs.workingTreeFiles(repo, paths);
      }
    };
    rememberTrustedAuthoredProjectionFingerprint(rootDir, first, generationVcs);
    assert.equal(captureTrustedAuthoredProjectionFingerprint(rootDir, generationVcs), first);
    assert.equal(generationStatusCalls, 0);
    invalidateTrustedAuthoredProjectionFingerprint(rootDir, vcs);

    writeFileSync(path.join(taskRoot, "INDEX.md"), readFileSync(path.join(taskRoot, "INDEX.md"), "utf8").replace("title: Baseline", "title: Dirty baseline"), "utf8");
    let dirtyFallbackStats = 0;
    localProjectionSourceFileSystem.statSignature = (inputPath) => {
      dirtyFallbackStats += 1;
      return originalStatSignature(inputPath);
    };
    let dirty: string;
    try {
      dirty = captureTrustedAuthoredProjectionFingerprint(rootDir, vcs);
    } finally {
      localProjectionSourceFileSystem.statSignature = originalStatSignature;
    }
    assert.notEqual(dirty, first);
    assert.ok(dirtyFallbackStats > 0);
  });
});

test("trusted generation fingerprint advances across a clean descendant HEAD with touched-path parity", () => {
  withTempStore((rootDir) => {
    initAuthoredGit(rootDir);
    const taskRoot = path.join(rootDir, "harness/tasks/task-baseline");
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(path.join(taskRoot, "INDEX.md"), [
      "---",
      "schema: task-package/v2",
      "task_id: task-baseline",
      "title: Baseline",
      "status: active",
      "packageDisposition: active",
      "---",
      ""
    ].join("\n"), "utf8");
    git(rootDir, "add", "--", "tasks/task-baseline/INDEX.md");
    git(rootDir, "commit", "-m", "seed descendant fingerprint baseline");
    rebuildTaskProjection({ rootDir });

    const vcs = makeLocalVersionControlSystem();
    const first = captureTrustedAuthoredProjectionFingerprint(rootDir, vcs);
    writeFileSync(
      path.join(taskRoot, "INDEX.md"),
      readFileSync(path.join(taskRoot, "INDEX.md"), "utf8").replace("title: Baseline", "title: Descendant"),
      "utf8"
    );
    git(rootDir, "add", "--", "tasks/task-baseline/INDEX.md");
    git(rootDir, "commit", "-m", "authority evidence descendant");
    const expected = captureAuthoredProjectionFingerprint(rootDir);

    let changedBetweenCalls = 0;
    const descendantVcs = {
      ...vcs,
      changedFilesBetween: (repo: string, before: string, after: string) => {
        changedBetweenCalls += 1;
        return vcs.changedFilesBetween(repo, before, after);
      }
    };
    assert.equal(captureTrustedAuthoredProjectionFingerprint(rootDir, descendantVcs), expected);
    assert.equal(changedBetweenCalls, 1);
    assert.notEqual(expected, first);
  });
});

test("single authority commit materialization reuses its complete semantic message", () => {
  withTempStore((rootDir) => {
    initAuthoredGit(rootDir);
    const opId = "namespace-test:semantic-merge";
    const integrity = buildAuthorityBatchIntegrity([{
      opId,
      semanticMutationSetDigest: "ab".repeat(32)
    }]);
    const message = `task(progress-append): task-semantic progress.md [${opId}]\n\n${authorityBatchTrailerName}: ${integrity.trailerValue}`;
    const harnessRoot = path.join(rootDir, "harness");
    git(rootDir, "checkout", "-b", "sessions/semantic-merge");
    writeFileSync(path.join(harnessRoot, "semantic.txt"), "semantic\n");
    git(rootDir, "add", "--", "semantic.txt");
    git(rootDir, "commit", "-m", message);
    git(rootDir, "checkout", "master");

    const report = runLedgerMaterializer(rootDir);

    assert.equal(report.merged, 1);
    assert.equal(git(rootDir, "show", "-s", "--format=%B", "HEAD"), message);
    assert.equal(git(rootDir, "rev-list", "--count", "HEAD^2^..HEAD^2"), "1");
  });
});

test("multi-commit authority branch retains the legacy materializer subject", () => {
  withTempStore((rootDir) => {
    initAuthoredGit(rootDir);
    const opId = "namespace-test:multi-commit";
    const integrity = buildAuthorityBatchIntegrity([{
      opId,
      semanticMutationSetDigest: "cd".repeat(32)
    }]);
    const harnessRoot = path.join(rootDir, "harness");
    git(rootDir, "checkout", "-b", "sessions/multi-authority");
    writeFileSync(path.join(harnessRoot, "first.txt"), "first\n");
    git(rootDir, "add", "--", "first.txt");
    git(rootDir, "commit", "-m", "legacy first");
    writeFileSync(path.join(harnessRoot, "second.txt"), "second\n");
    git(rootDir, "add", "--", "second.txt");
    git(
      rootDir,
      "commit",
      "-m",
      `task(progress-append): task-multi progress.md [${opId}]\n\n${authorityBatchTrailerName}: ${integrity.trailerValue}`
    );
    git(rootDir, "checkout", "master");

    const report = runLedgerMaterializer(rootDir);

    assert.equal(report.merged, 1);
    assert.equal(git(rootDir, "show", "-s", "--format=%s", "HEAD"), "materializer: merge session multi-authority");
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

test("concurrent preset script sessions both merge without losing fixed-path machine artifacts", () => {
  withTempStore((rootDir) => {
    initAuthoredGit(rootDir);
    const first = createPresetScriptSession(rootDir, "preset-session-one", "first-result");
    const second = createPresetScriptSession(rootDir, "preset-session-two", "second-result");

    const report = runLedgerMaterializer(rootDir);

    assert.equal(report.merged, 2, JSON.stringify(report));
    assert.equal(report.branches.filter((branch) => branch.status === "conflict").length, 0, JSON.stringify(report));
    assert.equal(git(rootDir, "branch", "--list", "sessions/preset-session-*"), "");
    git(rootDir, "merge-base", "--is-ancestor", first.commit, "master");
    git(rootDir, "merge-base", "--is-ancestor", second.commit, "master");

    const resultPaths = git(rootDir, "ls-tree", "-r", "--name-only", "master", "--", presetArtifactsPath)
      .split(/\r?\n/u)
      .filter((entry) => entry.endsWith("preset-result.json"));
    const resultBodies = resultPaths.map((entry) => readGitFile(rootDir, entry));
    assert.deepEqual(new Set(resultBodies), new Set([first.resultBody, second.resultBody]));
  });
});

const presetArtifactsPath = "tasks/task-concurrent-preset/artifacts";

function createPresetScriptSession(
  rootDir: string,
  sessionId: string,
  marker: string
): { readonly commit: string; readonly resultBody: string } {
  const harnessRoot = path.join(rootDir, "harness");
  const artifactsRoot = path.join(harnessRoot, presetArtifactsPath);
  const resultBody = `${JSON.stringify({
    schema: "script-result/v1",
    ok: true,
    report: { marker }
  }, null, 2)}\n`;
  const registryBody = `${JSON.stringify({
    schema: "machine-evidence-registry/v1",
    boundary: "preset-machine-evidence",
    entries: [{
      path: "artifacts/preset-result.json",
      sha256: `sha256:${createHash("sha256").update(resultBody).digest("hex")}`,
      recordedAt: "1970-01-01T00:00:00.000Z"
    }]
  }, null, 2)}\n`;

  git(rootDir, "checkout", "-b", `sessions/${sessionId}`, "master");
  mkdirSync(artifactsRoot, { recursive: true });
  writeFileSync(path.join(artifactsRoot, "preset-result.json"), resultBody, "utf8");
  writeFileSync(path.join(artifactsRoot, ".machine-evidence.registry.json"), registryBody, "utf8");
  git(rootDir, "add", "--", presetArtifactsPath);
  git(rootDir, "commit", "-m", `entity(script-ingest): script-run/${sessionId} [script-${sessionId}]`);
  const commit = git(rootDir, "rev-parse", "HEAD");
  git(rootDir, "checkout", "master");
  return { commit, resultBody };
}

function initAuthoredGit(rootDir: string, trunk = "master"): void {
  const harnessRoot = path.join(rootDir, "harness");
  mkdirSync(harnessRoot, { recursive: true });
  execFileSync("git", ["-C", harnessRoot, "init", "-b", trunk], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "config", "user.name", "Harness Test"], { stdio: "ignore" });
  execFileSync("git", ["-C", harnessRoot, "config", "user.email", "harness@example.test"], { stdio: "ignore" });
  writeFileSync(path.join(harnessRoot, ".gitkeep"), "", "utf8");
  execFileSync("git", ["-C", harnessRoot, "add", "--", ".gitkeep"], { stdio: "ignore" });
  execFileSync("git", [
    "-C", harnessRoot,
    "-c", "user.name=Harness Test",
    "-c", "user.email=harness@example.test",
    "commit", "-m", "seed"
  ], { stdio: "ignore" });
}

function git(rootDir: string, ...args: ReadonlyArray<string>): string {
  return execFileSync("git", [
    "-C", path.join(rootDir, "harness"),
    "-c", "user.name=Harness Test",
    "-c", "user.email=harness@example.test",
    ...args
  ], {
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
